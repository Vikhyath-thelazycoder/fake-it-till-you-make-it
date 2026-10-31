// Plays whole games with bots that behave like real phones: each holds its own live
// connection, runs the same backup checks and reads, and taps at human speed.
//   npm run bots -- --screens 80 --label local-80
//   --per-round 2  plays only the first 2 questions of each round (a quick dry run)
import { createClient } from "@supabase/supabase-js";
import { Admin, BASE, percentile, refuseLiveGame, sheetPoints, sleep, writeReport } from "./lib";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const SCREENS = Number(arg("screens", "80"));
const LABEL = arg("label", `bots-${SCREENS}`);
const PER_ROUND = Number(arg("per-round", "0"));
const GAP_MS = Number(arg("gap", "4000"));

type Live = {
  gameId: string;
  v: string;
  run: { id: string; options: { key: string }[]; startedAt: string; deadlineAt: string; limitSeconds: number } | null;
};
type Call = { name: string; ms: number; status: number };
type Sent = { team: string; run: string; choice: string; status: string; replyMs: number };
type AdminQuestion = { id: string; round_number: number; position: number; correct_option: string | null; options: { key: string }[] };

const calls: Call[] = [];
const sent: Sent[] = [];
const seen: { team: string; run: string; delayMs: number; via: string }[] = [];
const realtime = { subscribed: 0, failed: 0, signals: 0, reconnects: 0 };
const problems: string[] = [];

async function timed(name: string, input: string, init?: RequestInit): Promise<Response | null> {
  const started = performance.now();
  try {
    const response = await fetch(input, init);
    calls.push({ name, ms: performance.now() - started, status: response.status });
    return response;
  } catch (error) {
    calls.push({ name, ms: performance.now() - started, status: 0 });
    return null;
  }
}

class Bot {
  token = "";
  teamId = "";
  private version: string | null = null;
  private answering = new Set<string>();
  private stopped = false;
  private channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
  private client: ReturnType<typeof createClient> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;

  constructor(
    private index: number,
    private code: string,
    private answerKey: () => Map<string, string | null>,
    private questionOf: (run: Live["run"]) => string | undefined,
  ) {}

  async start(): Promise<void> {
    const response = await timed("join", `${BASE}/api/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: this.code,
        teamName: `Crew ${this.index}`,
        leaderName: `Lead ${this.index}`,
        members: [`A${this.index}`, `B${this.index}`, `C${this.index}`],
      }),
    });
    if (!response?.ok) throw new Error(`join failed: ${response?.status}`);
    const data = (await response.json()) as { token: string; team: { id: string } };
    this.token = data.token;
    this.teamId = data.team.id;
    await timed("me", `${BASE}/api/me`, { headers: { Authorization: `Bearer ${this.token}` } });
    await timed("time", `${BASE}/api/time`);

    this.client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.channel = this.client
      .channel("fake-it")
      .on("broadcast", { event: "changed" }, ({ payload }) => {
        realtime.signals += 1;
        const version = payload?.v as string | undefined;
        if (version !== this.version) void this.read("signal", version);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") realtime.subscribed += 1;
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") realtime.failed += 1;
        else if (status === "CLOSED" && !this.stopped) realtime.reconnects += 1;
      });
    void this.backup();
  }

  private async read(via: string, version?: string): Promise<void> {
    const response = await timed("live", version ? `${BASE}/api/live?v=${encodeURIComponent(version)}` : `${BASE}/api/live`);
    if (!response?.ok) {
      this.failures += 1;
      return;
    }
    this.failures = 0;
    const state = (await response.json()) as Live;
    if (state.v === this.version) return;
    this.version = state.v;
    if (!state.run || this.answering.has(state.run.id)) return;
    if (Date.parse(state.run.deadlineAt) <= Date.now()) return;
    this.answering.add(state.run.id);
    seen.push({ team: this.teamId, run: state.run.id, delayMs: Date.now() - Date.parse(state.run.startedAt), via });
    void this.play(state.run);
  }

  private async backup(): Promise<void> {
    if (this.stopped) return;
    await this.read("backup");
    if (this.stopped) return;
    const wait = this.failures === 0 ? 4000 : Math.min(4000 * 2 ** this.failures, 30000);
    this.timer = setTimeout(() => void this.backup(), wait * (0.7 + Math.random() * 0.6));
  }

  // Human: reads, argues as a team, then taps. Some never answer. Some cut it very close.
  private async play(run: NonNullable<Live["run"]>): Promise<void> {
    const limit = run.limitSeconds * 1000;
    const roll = Math.random();
    if (roll < 0.04) return;
    const thinkMs = roll < 0.08 ? limit - 300 : 1500 + Math.random() ** 1.3 * (limit - 3000);
    const wait = Date.parse(run.startedAt) + thinkMs - Date.now();
    if (wait > 0) await sleep(wait);

    const questionId = this.questionOf(run);
    const correct = questionId ? this.answerKey().get(questionId) : null;
    const right = Math.random() < 0.65;
    const wrong = run.options.filter((o) => o.key !== correct);
    const choice = right && correct ? correct : wrong[Math.floor(Math.random() * wrong.length)].key;
    await this.send(run.id, choice);
    if (Math.random() < 0.05) await this.send(run.id, run.options[0].key); // A double tap.
  }

  private async send(runId: string, choice: string): Promise<void> {
    const started = performance.now();
    const response = await timed("answer", `${BASE}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ runId, choice }),
    });
    const body = response?.ok ? ((await response.json()) as { status: string }) : { status: `http_${response?.status ?? 0}` };
    sent.push({ team: this.teamId, run: runId, choice, status: body.status, replyMs: performance.now() - started });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.channel) await this.client?.removeChannel(this.channel);
  }
}

async function main() {
  refuseLiveGame();
  const startedAt = new Date();
  const admin = new Admin();
  await admin.login();
  await admin.json("POST", "/new-game", { confirm: "NEW GAME" });
  await admin.json("POST", "/teams/generate", { count: SCREENS });

  // Rounds 1 and 2 have no answers yet in the database: give them test answers for this run.
  type State = { game: { id: string }; teams: { code: string }[]; questions: AdminQuestion[]; rounds: { number: number }[] };
  let state = await admin.json<State>("GET", "/state");
  for (const round of [1, 2]) {
    const questions = state.questions.filter((q) => q.round_number === round);
    if (questions.some((q) => !q.correct_option)) {
      await admin.json("POST", "/answers/bulk", {
        round,
        answers: questions.map(() => (Math.random() < 0.5 ? "AI" : "REAL")),
      });
    }
  }
  state = await admin.json<State>("GET", "/state");
  const key = new Map(state.questions.map((q) => [q.id, q.correct_option]));
  const runToQuestion = new Map<string, string>();

  const bots = state.teams.map(
    (team, index) =>
      new Bot(
        index + 1,
        team.code,
        () => key,
        (run) => (run ? runToQuestion.get(run.id) : undefined),
      ),
  );
  // Crews sign up over a minute or so, not in one burst.
  const signupMs = Number(arg("signup", "45000"));
  const joinStart = Date.now();
  await Promise.all(
    bots.map(async (bot, index) => {
      await sleep((index / bots.length) * signupMs);
      await bot.start();
    }),
  );
  console.log(`${bots.length} screens joined in ${((Date.now() - joinStart) / 1000).toFixed(0)} s`);
  await sleep(4000);

  // Like the real admin tab and the projector: they keep polling through the game.
  let stopPolling = false;
  const adminPoll = (async () => {
    while (!stopPolling) {
      const started = performance.now();
      const response = await admin.call("GET", "/state").catch(() => null);
      calls.push({ name: "admin_state", ms: performance.now() - started, status: response?.status ?? 0 });
      await response?.arrayBuffer().catch(() => undefined);
      await sleep(2000);
    }
  })();
  const projectorPoll = (async () => {
    while (!stopPolling) {
      const response = await timed("results", `${BASE}/api/results`);
      await response?.arrayBuffer().catch(() => undefined);
      await sleep(3000);
    }
  })();

  const played: { questionId: string; runId: string; limit: number; startMs: number }[] = [];
  const toPlay = state.rounds.flatMap((round) => {
    const questions = state.questions.filter((q) => q.round_number === round.number);
    return PER_ROUND ? questions.slice(0, PER_ROUND) : questions;
  });
  const gameStart = Date.now();
  for (const [index, question] of toPlay.entries()) {
    const started = performance.now();
    const response = await admin.call("POST", "/runs", { questionId: question.id });
    calls.push({ name: "admin_start", ms: performance.now() - started, status: response.status });
    if (!response.ok) {
      problems.push(`Could not start question ${question.id}: ${response.status} ${await response.text()}`);
      continue;
    }
    await response.arrayBuffer();
    const live = (await (await fetch(`${BASE}/api/live`)).json()) as Live;
    if (!live.run) throw new Error("started question is not live");
    runToQuestion.set(live.run.id, question.id);
    played.push({ questionId: question.id, runId: live.run.id, limit: live.run.limitSeconds, startMs: Date.now() });
    console.log(`Q${index + 1}/${toPlay.length} R${question.round_number} #${question.position} running`);
    await sleep(Date.parse(live.run.deadlineAt) - Date.now() + 1500 + GAP_MS);
  }
  stopPolling = true;
  await Promise.all([adminPoll, projectorPoll]);
  const gameMinutes = (Date.now() - gameStart) / 60000;

  await admin.json("POST", "/publish", { published: true });
  const published = (await (await fetch(`${BASE}/api/results`)).json()) as { published: boolean; ranking: { teamId: string; points: number; rank: number; correct: number; totalMs: number }[] };
  await Promise.all(bots.map((bot) => bot.stop()));

  // The checker: recompute every score from the raw rows and the user's sheet.
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const rows: { run_id: string; team_id: string; choice: string; elapsed_ms: number; points_if_correct: number }[] = [];
  for (const run of played) {
    const { data, error } = await db.from("answers").select("*").eq("run_id", run.runId);
    if (error) throw error;
    rows.push(...data);
  }
  const runInfo = new Map(played.map((p) => [p.runId, p]));
  const locked = sent.filter((s) => s.status === "locked");
  const firstChoice = new Map(locked.map((s) => [`${s.run}:${s.team}`, s.choice]));
  const expected = new Map<string, { points: number; correct: number; ms: number }>();
  for (const bot of bots) expected.set(bot.teamId, { points: 0, correct: 0, ms: 0 });
  for (const row of rows) {
    const run = runInfo.get(row.run_id)!;
    const points = sheetPoints(row.elapsed_ms, run.limit);
    if (points !== row.points_if_correct) problems.push(`Points differ from the sheet: ${JSON.stringify(row)}`);
    if (row.elapsed_ms > run.limit * 1000 + 1000) problems.push(`Answer accepted too late: ${JSON.stringify(row)}`);
    if (firstChoice.get(`${row.run_id}:${row.team_id}`) !== row.choice) problems.push(`Stored choice is not what the bot first sent: ${JSON.stringify(row)}`);
    if (key.get(run.questionId) === row.choice) {
      const total = expected.get(row.team_id)!;
      total.points += points;
      total.correct += 1;
      total.ms += row.elapsed_ms;
    }
  }
  if (rows.length !== locked.length) problems.push(`${locked.length} answers told "locked" but ${rows.length} are stored`);
  const seenByRun = new Set(rows.map((r) => `${r.run_id}:${r.team_id}`));
  if (seenByRun.size !== rows.length) problems.push("A team has two answers to one question");
  if (!published.published) problems.push("Results did not publish");
  if (published.ranking.length !== bots.length) problems.push(`${published.ranking.length} crews ranked, expected ${bots.length}`);
  let mismatched = 0;
  for (const row of published.ranking) {
    const total = expected.get(row.teamId);
    if (!total || total.points !== row.points || total.correct !== row.correct || total.ms !== Number(row.totalMs)) mismatched += 1;
  }
  if (mismatched) problems.push(`${mismatched} crews' scores differ from the recalculation`);
  const sortedOk = published.ranking.every((row, index, all) => {
    if (index === 0) return true;
    const before = all[index - 1];
    if (before.points !== row.points) return before.points > row.points;
    if (before.correct !== row.correct) return before.correct > row.correct;
    return Number(before.totalMs) <= Number(row.totalMs);
  });
  if (!sortedOk) problems.push("The ranking is in the wrong order");

  // Which screens never saw a question they should have.
  const missed = played.length * bots.length - seen.length;
  if (missed > 0) problems.push(`${missed} question showings were missed by screens`);

  const names = [...new Set(calls.map((c) => c.name))];
  const delays = seen.map((s) => s.delayMs);
  const report = {
    label: LABEL,
    base: BASE,
    started_at: startedAt.toISOString(),
    screens: bots.length,
    questions_played: played.length,
    game_minutes: Number(gameMinutes.toFixed(1)),
    problems,
    totals: {
      calls: calls.length,
      server_errors_5xx: calls.filter((c) => c.status >= 500).length,
      network_failures: calls.filter((c) => c.status === 0).length,
      answers_locked: locked.length,
      answers_stored: rows.length,
      duplicates_refused: sent.filter((s) => s.status === "duplicate").length,
      late_refused: sent.filter((s) => s.status === "late").length,
    },
    realtime,
    question_reached_screen_ms: {
      p50: percentile(delays, 50),
      p95: percentile(delays, 95),
      p99: percentile(delays, 99),
      max: Math.max(...delays),
      via_signal: seen.filter((s) => s.via === "signal").length,
      via_backup: seen.filter((s) => s.via === "backup").length,
    },
    by_call: Object.fromEntries(
      names.map((name) => {
        const list = calls.filter((c) => c.name === name);
        const ms = list.map((c) => c.ms);
        return [name, { calls: list.length, errors: list.filter((c) => c.status >= 500 || c.status === 0).length, p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), max: Math.round(Math.max(...ms)) }];
      }),
    ),
    top_3: published.ranking.slice(0, 3),
  };
  const path = writeReport(LABEL, report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${path}`);
  console.log(problems.length === 0 && report.totals.server_errors_5xx === 0 ? "RESULT: PASS" : "RESULT: PROBLEMS FOUND");
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
