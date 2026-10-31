import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db, signalChanged } from "./db";
import {
  bearerToken,
  clearAdminCookie,
  hashToken,
  newTeamCode,
  newToken,
  passcodeMatches,
  requireAdmin,
  setAdminCookie,
} from "./auth";

type LiveState = {
  gameId: string;
  version: number;
  published: boolean;
  run: { id: string; startedAt: string; deadlineAt: string } | null;
};

const name = z.string().trim().min(1).max(40);

const joinBody = z.object({
  code: z.string().trim().toUpperCase().min(1).max(12),
  teamName: name,
  leaderName: name,
  members: z.array(name).length(3),
});
const rejoinBody = z.object({
  code: z.string().trim().toUpperCase().min(1).max(12),
  leaderName: name,
});
const answerBody = z.object({ runId: z.uuid(), choice: z.string().min(1).max(10) });

const questionFields = {
  title: z.string().trim().max(120).nullable().optional(),
  hint: z.string().trim().max(200).nullable().optional(),
  prompt: z.string().trim().min(1).max(500),
  body: z.string().trim().max(2000).nullable().optional(),
  options: z
    .array(z.object({ key: z.string().trim().min(1).max(10), label: z.string().trim().min(1).max(300) }))
    .min(2)
    .max(4),
  correctOption: z.string().trim().min(1).max(10).nullable().optional(),
};
const newQuestionBody = z.object({ round: z.number().int().min(1).max(4), ...questionFields });
const editQuestionBody = z.object(questionFields).partial();
const bulkAnswersBody = z.object({
  round: z.number().int().min(1).max(4),
  answers: z.array(z.string().trim().min(1).max(10)).min(1).max(200),
});

function versionOf(state: LiveState): string {
  return `${state.gameId}:${state.version}`;
}

// A short memory of the live state, so a crowd of phones on one server costs one read.
let liveMemo: { state: LiveState; at: number } | null = null;
const LIVE_MEMO_MS = 1000;

async function readLive(): Promise<LiveState> {
  const { data, error } = await db.rpc("live_state");
  if (error) throw error;
  return data as LiveState;
}

async function afterChange(): Promise<string> {
  liveMemo = null;
  const state = await readLive();
  liveMemo = { state, at: Date.now() };
  const version = versionOf(state);
  await signalChanged(version);
  return version;
}

async function activeGameId(): Promise<string> {
  const { data, error } = await db.from("games").select("id").eq("is_active", true).single();
  if (error) throw error;
  return data.id as string;
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  // The shared question: no team data, no answer, safe for the CDN to serve to everyone.
  app.get("/api/live", async (req, res) => {
    const asked = typeof req.query.v === "string" ? req.query.v : null;
    const fresh = liveMemo && Date.now() - liveMemo.at < LIVE_MEMO_MS;
    let state: LiveState;
    if (liveMemo && fresh && (!asked || asked === versionOf(liveMemo.state))) {
      state = liveMemo.state;
    } else {
      state = await readLive();
      liveMemo = { state, at: Date.now() };
    }
    const current = versionOf(state);
    if (asked && asked !== current) {
      res.setHeader("Cache-Control", "no-store");
    } else if (asked) {
      res.setHeader("Cache-Control", "public, s-maxage=60");
    } else {
      res.setHeader("Cache-Control", "public, s-maxage=1");
    }
    res.json({ ...state, v: current });
  });

  app.get("/api/time", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ now: Date.now() });
  });

  app.post("/api/join", async (req, res) => {
    const body = joinBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Please fill in the crew name and all four names" });
      return;
    }
    const { code, teamName, leaderName, members } = body.data;
    const gameId = await activeGameId();
    const token = newToken();
    const { data, error } = await db
      .from("teams")
      .update({
        name: teamName,
        leader_name: leaderName,
        members,
        token_hash: hashToken(token),
        joined_at: new Date().toISOString(),
      })
      .eq("game_id", gameId)
      .eq("code", code)
      .is("name", null)
      .select("id, name, leader_name, members")
      .maybeSingle();
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "That crew name is taken. Pick another one." });
      return;
    }
    if (error) throw error;
    if (!data) {
      const { data: existing } = await db
        .from("teams")
        .select("id")
        .eq("game_id", gameId)
        .eq("code", code)
        .maybeSingle();
      res.status(existing ? 409 : 404).json({
        error: existing
          ? "This code has already joined. If your phone changed, use Log back in."
          : "That secret code is not right. Check your player card.",
      });
      return;
    }
    res.json({ token, team: { id: data.id, name: data.name, leaderName: data.leader_name, members: data.members } });
  });

  app.post("/api/rejoin", async (req, res) => {
    const body = rejoinBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Please enter the secret code and leader name" });
      return;
    }
    const gameId = await activeGameId();
    const { data: team, error } = await db
      .from("teams")
      .select("id, name, leader_name, members")
      .eq("game_id", gameId)
      .eq("code", body.data.code)
      .not("name", "is", null)
      .maybeSingle();
    if (error) throw error;
    if (!team || team.leader_name.toLowerCase() !== body.data.leaderName.toLowerCase()) {
      res.status(404).json({ error: "That code and leader name don't match a crew." });
      return;
    }
    const token = newToken();
    const { error: updateError } = await db.from("teams").update({ token_hash: hashToken(token) }).eq("id", team.id);
    if (updateError) throw updateError;
    res.json({ token, team: { id: team.id, name: team.name, leaderName: team.leader_name, members: team.members } });
  });

  // A phone opening or reconnecting: who am I, and did we already answer this question?
  app.get("/api/me", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Please join first" });
      return;
    }
    const { data: team, error } = await db
      .from("teams")
      .select("id, game_id, name, leader_name, members")
      .eq("token_hash", hashToken(token))
      .maybeSingle();
    if (error) throw error;
    if (!team) {
      res.status(401).json({ error: "Please join first" });
      return;
    }
    let answeredChoice: string | null = null;
    const runId = typeof req.query.run === "string" ? z.uuid().safeParse(req.query.run) : null;
    if (runId?.success) {
      const { data: answer } = await db
        .from("answers")
        .select("choice")
        .eq("team_id", team.id)
        .eq("run_id", runId.data)
        .maybeSingle();
      answeredChoice = answer?.choice ?? null;
    }
    res.json({
      team: { id: team.id, gameId: team.game_id, name: team.name, leaderName: team.leader_name, members: team.members },
      answeredChoice,
    });
  });

  app.post("/api/answer", async (req, res) => {
    const token = bearerToken(req);
    const body = answerBody.safeParse(req.body);
    if (!token) {
      res.status(401).json({ error: "Please join first" });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: "Bad answer" });
      return;
    }
    const { data, error } = await db.rpc("submit_answer", {
      p_token_hash: hashToken(token),
      p_run_id: body.data.runId,
      p_choice: body.data.choice,
    });
    if (error) throw error;
    const status = data as string;
    const code = status === "bad_token" ? 401 : status === "bad_choice" || status === "no_question" ? 400 : 200;
    // Nothing about right or wrong goes back to the phone.
    res.status(code).json({ status });
  });

  // Public only after the admin publishes.
  app.get("/api/results", async (_req, res) => {
    res.setHeader("Cache-Control", "public, s-maxage=2");
    const { data: game, error } = await db
      .from("games")
      .select("id, results_published_at")
      .eq("is_active", true)
      .single();
    if (error) throw error;
    if (!game.results_published_at) {
      res.json({ published: false, ranking: [] });
      return;
    }
    const { data, error: boardError } = await db.rpc("leaderboard", { p_game_id: game.id });
    if (boardError) throw boardError;
    res.json({
      published: true,
      ranking: (data ?? []).map((row: Record<string, unknown>) => ({
        teamId: row.team_id,
        name: row.name,
        points: row.points,
        correct: row.correct,
        totalMs: row.total_ms,
        rank: row.rank,
      })),
    });
  });

  app.post("/api/admin/login", (req, res) => {
    const passcode = typeof req.body?.passcode === "string" ? req.body.passcode : "";
    if (!passcodeMatches(passcode)) {
      res.status(401).json({ error: "Wrong passcode" });
      return;
    }
    setAdminCookie(res);
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", (_req, res) => {
    clearAdminCookie(res);
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use(requireAdmin);
  admin.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  admin.get("/state", async (_req, res) => {
    const { data: game, error: gameError } = await db
      .from("games")
      .select("id, version, results_published_at, created_at")
      .eq("is_active", true)
      .single();
    if (gameError) throw gameError;
    const [rounds, questions, teams, runs] = await Promise.all([
      db.from("rounds").select("*").order("number"),
      db.from("questions").select("*").order("round_number").order("position").order("created_at"),
      db
        .from("teams")
        .select("id, code, name, leader_name, members, joined_at")
        .eq("game_id", game.id)
        .order("joined_at", { nullsFirst: false })
        .order("code"),
      db
        .from("question_runs")
        .select("id, question_id, started_at, deadline_at, answers(count)")
        .eq("game_id", game.id),
    ]);
    for (const result of [rounds, questions, teams, runs]) if (result.error) throw result.error;
    res.json({ game, rounds: rounds.data, questions: questions.data, teams: teams.data, runs: runs.data, now: Date.now() });
  });

  admin.get("/results", async (_req, res) => {
    const gameId = await activeGameId();
    const { data, error } = await db.rpc("leaderboard", { p_game_id: gameId });
    if (error) throw error;
    res.json({ ranking: data ?? [] });
  });

  admin.post("/questions", async (req, res) => {
    const body = newQuestionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Please fill in the question and its options" });
      return;
    }
    const { round, correctOption, ...rest } = body.data;
    const { data: last } = await db
      .from("questions")
      .select("position")
      .eq("round_number", round)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data, error } = await db
      .from("questions")
      .insert({ round_number: round, position: (last?.position ?? 0) + 1, correct_option: correctOption ?? null, ...rest })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  });

  admin.patch("/questions/:id", async (req, res) => {
    const body = editQuestionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "That change is not valid" });
      return;
    }
    const { correctOption, ...rest } = body.data;
    const { data, error } = await db
      .from("questions")
      .update({ ...rest, ...(correctOption !== undefined ? { correct_option: correctOption } : {}) })
      .eq("id", req.params.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "Question not found" });
      return;
    }
    res.json(data);
  });

  admin.delete("/questions/:id", async (req, res) => {
    const gameId = await activeGameId();
    const { data: played } = await db
      .from("question_runs")
      .select("id")
      .eq("game_id", gameId)
      .eq("question_id", req.params.id)
      .maybeSingle();
    if (played) {
      res.status(409).json({ error: "This question was already played in this game. Reset it first." });
      return;
    }
    const { error } = await db.from("questions").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  });

  // Paste a whole round's answers at once, in question order.
  admin.post("/answers/bulk", async (req, res) => {
    const body = bulkAnswersBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Please paste the answers" });
      return;
    }
    const { data: questions, error } = await db
      .from("questions")
      .select("id, options")
      .eq("round_number", body.data.round)
      .order("position")
      .order("created_at");
    if (error) throw error;
    if (questions.length !== body.data.answers.length) {
      res.status(400).json({ error: `This round has ${questions.length} questions, but you pasted ${body.data.answers.length} answers.` });
      return;
    }
    const keys = body.data.answers.map((raw, index) => {
      const options = questions[index].options as { key: string; label: string }[];
      const wanted = raw.toUpperCase();
      return options.find((o) => o.key.toUpperCase() === wanted || o.label.toUpperCase() === wanted)?.key ?? null;
    });
    const bad = keys.indexOf(null);
    if (bad !== -1) {
      res.status(400).json({ error: `Answer ${bad + 1} ("${body.data.answers[bad]}") is not one of that question's options.` });
      return;
    }
    const results = await Promise.all(
      questions.map((question, index) => db.from("questions").update({ correct_option: keys[index] }).eq("id", question.id)),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) throw failed.error;
    res.json({ updated: questions.length });
  });

  admin.post("/runs", async (req, res) => {
    const questionId = z.uuid().safeParse(req.body?.questionId);
    if (!questionId.success) {
      res.status(400).json({ error: "Pick a question" });
      return;
    }
    const { data, error } = await db.rpc("start_question", { p_question_id: questionId.data });
    if (error) throw error;
    if (data !== "started") {
      const message: Record<string, string> = {
        busy: "A question is still running.",
        already_played: "This question was already played. Reset it to play it again.",
        not_found: "Question not found.",
      };
      res.status(409).json({ error: message[data as string] ?? "Could not start" });
      return;
    }
    res.json({ v: await afterChange() });
  });

  admin.post("/runs/:questionId/reset", async (req, res) => {
    const questionId = z.uuid().safeParse(req.params.questionId);
    if (!questionId.success) {
      res.status(400).json({ error: "Pick a question" });
      return;
    }
    const { error } = await db.rpc("reset_question", { p_question_id: questionId.data });
    if (error) throw error;
    res.json({ v: await afterChange() });
  });

  admin.post("/teams/generate", async (req, res) => {
    const count = z.number().int().min(1).max(200).safeParse(req.body?.count);
    if (!count.success) {
      res.status(400).json({ error: "Enter how many team codes to make (1 to 200)" });
      return;
    }
    const gameId = await activeGameId();
    const codes = new Set<string>();
    while (codes.size < count.data) codes.add(newTeamCode());
    const { error } = await db
      .from("teams")
      .upsert(
        [...codes].map((code) => ({ game_id: gameId, code })),
        { onConflict: "game_id,code", ignoreDuplicates: true },
      );
    if (error) throw error;
    res.json({ ok: true });
  });

  admin.delete("/teams/:id", async (req, res) => {
    const { error } = await db.from("teams").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  });

  admin.post("/publish", async (req, res) => {
    const { error } = await db.rpc("set_published", { p_published: req.body?.published === true });
    if (error) throw error;
    res.json({ v: await afterChange() });
  });

  admin.post("/new-game", async (req, res) => {
    if (req.body?.confirm !== "NEW GAME") {
      res.status(400).json({ error: 'Type NEW GAME to confirm' });
      return;
    }
    const { error } = await db.rpc("new_game");
    if (error) throw error;
    res.json({ v: await afterChange() });
  });

  app.use("/api/admin", admin);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Bad JSON or an oversized body is the caller's mistake, not a server error.
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: "Bad request" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
