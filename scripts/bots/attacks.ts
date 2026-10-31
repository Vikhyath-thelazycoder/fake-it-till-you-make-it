// Tries to cheat, as a player or an outsider. Each attempt must be refused.
import { createClient } from "@supabase/supabase-js";
import { Admin, BASE, refuseLiveGame } from "./lib";

const results: { attack: string; passed: boolean; detail: string }[] = [];
function check(attack: string, passed: boolean, detail = ""): void {
  results.push({ attack, passed, detail });
  console.log(`${passed ? "refused" : "FAILED "}  ${attack}${detail && !passed ? `  (${detail})` : ""}`);
}

async function post(path: string, body: unknown, token?: string, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  refuseLiveGame();
  const admin = new Admin();
  await admin.login();
  await admin.json("POST", "/new-game", { confirm: "NEW GAME" });
  await admin.json("POST", "/teams/generate", { count: 3 });
  type State = { teams: { code: string }[]; questions: { id: string; round_number: number; correct_option: string | null }[] };
  const state = await admin.json<State>("GET", "/state");
  const [codeA, codeB, codeC] = state.teams.map((t) => t.code);
  const joinBody = (code: string, name: string) => ({ code, teamName: name, leaderName: `${name} lead`, members: ["x", "y", "z"] });

  const a = (await (await post("/api/join", joinBody(codeA, "Alpha"))).json()) as { token: string; team: { id: string } };
  const b = (await (await post("/api/join", joinBody(codeB, "Bravo"))).json()) as { token: string };

  // Joining
  check("Made-up secret code", (await post("/api/join", joinBody("NOPE99", "Fake"))).status === 404);
  check("Taking a code that already joined", (await post("/api/join", joinBody(codeA, "Thief"))).status === 409);
  check("Using another crew's name", (await post("/api/join", joinBody(codeC, "alpha"))).status === 409);
  check("Rejoin with the wrong leader name", (await post("/api/rejoin", { code: codeA, leaderName: "Someone" })).status === 404);
  check("Missing teammates", (await post("/api/join", { code: codeC, teamName: "Short", leaderName: "L", members: ["x"] })).status === 400);
  check("A name far too long", (await post("/api/join", { ...joinBody(codeC, "L".repeat(500)) })).status === 400);
  check("SQL injection as a code", (await post("/api/join", joinBody("' OR 1=1", "Inject"))).status === 404);
  check("Oversized request", (await post("/api/join", { pad: "x".repeat(200_000) }).catch(() => ({ status: 413 } as Response))).status >= 400);

  // Reading the answers
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  for (const table of ["questions", "teams", "answers", "games", "question_runs", "rounds"]) {
    const { data, error } = await anon.from(table).select("*").limit(1);
    check(`Reading ${table} directly from Supabase`, !!error || (data ?? []).length === 0, JSON.stringify(data));
  }
  const { error: writeError } = await anon.from("answers").insert({ run_id: "00000000-0000-0000-0000-000000000000", team_id: a.team.id, choice: "A", elapsed_ms: 1, points_if_correct: 5 });
  check("Writing an answer directly to Supabase", !!writeError);
  const { error: qWrite } = await anon.from("questions").update({ correct_option: "A" }).neq("position", -1).select();
  check("Changing an answer directly in Supabase", !!qWrite || (await anon.from("questions").select("*")).data?.length === 0);
  for (const [fn, args] of [
    ["start_question", { p_question_id: state.questions[0].id }],
    ["new_game", {}],
    ["live_state", {}],
    ["set_published", { p_published: true }],
    ["submit_answer", { p_token_hash: "x", p_run_id: state.questions[0].id, p_choice: "A" }],
  ] as const) {
    const { error } = await anon.rpc(fn, args);
    check(`Calling ${fn} directly from Supabase`, !!error);
  }

  // Admin
  for (const [method, path] of [["GET", "/state"], ["GET", "/results"], ["POST", "/runs"], ["POST", "/new-game"], ["POST", "/publish"], ["POST", "/teams/generate"], ["POST", "/answers/bulk"]]) {
    const response = await fetch(`${BASE}/api/admin${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` }, body: method === "POST" ? "{}" : undefined });
    check(`Player token on admin ${method} ${path}`, response.status === 401, String(response.status));
  }
  const forged = await fetch(`${BASE}/api/admin/state`, { headers: { Cookie: `fi_admin=${Date.now() + 1e9}.${"a".repeat(64)}` } });
  check("Forged admin cookie", forged.status === 401);
  check("Wrong admin passcode", (await post("/api/admin/login", { passcode: "guess" })).status === 401);

  // Answering
  const results0 = (await (await fetch(`${BASE}/api/results`)).json()) as { published: boolean; ranking: unknown[] };
  check("Reading results before they are published", !results0.published && results0.ranking.length === 0);

  const round3 = state.questions.filter((q) => q.round_number === 3);
  await admin.json("POST", "/runs", { questionId: round3[0].id });
  const live = (await (await fetch(`${BASE}/api/live`)).json()) as { run: { id: string; startedAt: string; deadlineAt: string } };
  const liveText = JSON.stringify(live);
  check("Finding the answer in the live question", !liveText.includes("correct"));

  check("Answer with no login", (await post("/api/answer", { runId: live.run.id, choice: "A" })).status === 401);
  check("Answer with a made-up token", (await post("/api/answer", { runId: live.run.id, choice: "A" }, "made-up")).status === 401);
  check("Answer with a choice that doesn't exist", (await post("/api/answer", { runId: live.run.id, choice: "Z" }, a.token)).status === 400);
  check("Answer to a made-up question", (await post("/api/answer", { runId: "00000000-0000-0000-0000-000000000000", choice: "A" }, a.token)).status === 400);

  const first = await post("/api/answer", { runId: live.run.id, choice: "B", elapsed_ms: 1, points: 5 }, a.token);
  const firstBody = (await first.json()) as Record<string, unknown>;
  check("Learning right or wrong from the reply", JSON.stringify(Object.keys(firstBody)) === '["status"]', JSON.stringify(firstBody));
  const change = (await (await post("/api/answer", { runId: live.run.id, choice: "A" }, a.token)).json()) as { status: string };
  check("Changing an answer after locking it", change.status === "duplicate", change.status);

  const burst = await Promise.all(Array.from({ length: 20 }, () => post("/api/answer", { runId: live.run.id, choice: "A" }, b.token).then((r) => r.json() as Promise<{ status: string }>)));
  check("Twenty taps at once count once", burst.filter((r) => r.status === "locked").length === 1, JSON.stringify(burst.map((r) => r.status)));

  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: stored } = await db.from("answers").select("elapsed_ms").eq("team_id", a.team.id);
  check("Faking the answer time in the request", (stored?.[0]?.elapsed_ms ?? 0) > 1, JSON.stringify(stored));

  check("Starting a second question while one runs", (await admin.call("POST", "/runs", { questionId: round3[1].id })).status === 409);

  // A fake "changed" signal only makes a phone re-read. The real question is unchanged.
  const spoof = anon.channel("fake-it");
  await new Promise<void>((resolve) => spoof.subscribe((status) => status === "SUBSCRIBED" && resolve()));
  await spoof.send({ type: "broadcast", event: "changed", payload: { v: "fake:999" } });
  await anon.removeChannel(spoof);
  const afterSpoof = await fetch(`${BASE}/api/live?v=fake:999`);
  const spoofBody = (await afterSpoof.json()) as { run: { id: string } };
  check("Fake live signal can't change the question", spoofBody.run.id === live.run.id && afterSpoof.headers.get("cache-control") === "no-store");

  const lateMs = Date.parse(live.run.deadlineAt) - Date.now() + 1400;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, lateMs)));
  const c = (await (await post("/api/join", joinBody(codeC, "Charlie"))).json()) as { token: string };
  const late = (await (await post("/api/answer", { runId: live.run.id, choice: "A" }, c.token)).json()) as { status: string };
  check("Answering after time is up", late.status === "late", late.status);

  // Lost phone
  const again = (await (await post("/api/rejoin", { code: codeA, leaderName: "alpha LEAD" })).json()) as { token: string };
  const oldPhone = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${a.token}` } });
  check("Old phone stops working after a log back in", oldPhone.status === 401 && !!again.token, String(oldPhone.status));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length} attacks, ${failed.length} got through`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
