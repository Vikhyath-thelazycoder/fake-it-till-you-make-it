import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) process.env[match[1]] ??= match[2];
}
const url = process.env.SUPABASE_URL!;
if (!url.includes("127.0.0.1")) throw new Error("Scoring tests run on the local database only");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

// The user's points sheet, written out by hand on purpose so it can catch a formula mistake.
const SHEET_20: [number, number, number][] = [
  [20, 17, 5],
  [16, 13, 4],
  [12, 9, 3],
  [8, 5, 2],
  [4, 1, 1],
];
const SHEET_25: [number, number, number][] = [
  [25, 21, 5],
  [20, 16, 4],
  [15, 11, 3],
  [10, 6, 2],
  [5, 1, 1],
];

async function points(elapsedMs: number, limit: number): Promise<number> {
  const { data, error } = await db.rpc("speed_points", { p_elapsed_ms: elapsedMs, p_limit_seconds: limit });
  if (error) throw error;
  return data as number;
}

describe("the points sheet", () => {
  for (const [limit, sheet] of [
    [20, SHEET_20],
    [25, SHEET_25],
  ] as const) {
    it(`gives the sheet's points for every countdown second in a ${limit} s round`, async () => {
      for (const [high, low, expected] of sheet) {
        for (let shown = high; shown >= low; shown -= 1) {
          // The countdown shows `shown` from just above shown-1 seconds left up to shown left.
          expect(await points((limit - shown) * 1000, limit), `${shown} on the clock`).toBe(expected);
          expect(await points((limit - shown) * 1000 + 999, limit), `end of ${shown}`).toBe(expected);
        }
      }
    });
  }

  it("keeps an answer in the one second of grace at 1 point", async () => {
    expect(await points(20500, 20)).toBe(1);
    expect(await points(25900, 25)).toBe(1);
  });
});

describe("a game", () => {
  let questions: { id: string; correct_option: string | null; round_number: number }[];

  async function join(code: string, name: string): Promise<{ id: string; token: string }> {
    const token = `token-${name}-${crypto.randomUUID()}`;
    const { data, error } = await db
      .from("teams")
      .insert({ game_id: gameId, code, name, leader_name: name, members: [], token_hash: token })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, token };
  }

  async function run(questionId: string, secondsAgo: number): Promise<string> {
    const started = new Date(Date.now() - secondsAgo * 1000);
    const limit = 20;
    const { data, error } = await db
      .from("question_runs")
      .insert({
        game_id: gameId,
        question_id: questionId,
        time_limit_seconds: limit,
        started_at: started.toISOString(),
        deadline_at: new Date(started.getTime() + limit * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async function answer(token: string, runId: string, choice: string): Promise<string> {
    const { data, error } = await db.rpc("submit_answer", { p_token_hash: token, p_run_id: runId, p_choice: choice });
    if (error) throw error;
    return data as string;
  }

  async function board() {
    const { data, error } = await db.rpc("leaderboard", { p_game_id: gameId });
    if (error) throw error;
    return data as { name: string; points: number; correct: number; total_ms: number; rank: number }[];
  }

  let gameId: string;

  beforeEach(async () => {
    const { data, error } = await db.rpc("new_game");
    if (error) throw error;
    gameId = data as string;
    const result = await db.from("questions").select("id, correct_option, round_number").eq("round_number", 3).order("position");
    if (result.error) throw result.error;
    questions = result.data;
  });

  it("scores only correct answers", async () => {
    const right = await join("AAA", "right");
    const wrong = await join("BBB", "wrong");
    const runId = await run(questions[0].id, 0);
    expect(await answer(right.token, runId, "A")).toBe("locked");
    expect(await answer(wrong.token, runId, "B")).toBe("locked");
    const rows = await board();
    expect(rows.find((r) => r.name === "right")!.points).toBe(5);
    expect(rows.find((r) => r.name === "wrong")!.points).toBe(0);
  });

  it("keeps a team's first answer and refuses to change it", async () => {
    const team = await join("AAA", "once");
    const runId = await run(questions[0].id, 0);
    expect(await answer(team.token, runId, "B")).toBe("locked");
    expect(await answer(team.token, runId, "A")).toBe("duplicate");
    expect((await board())[0].points).toBe(0);
  });

  it("refuses an answer after the time and the grace second", async () => {
    const team = await join("AAA", "late");
    const runId = await run(questions[0].id, 22);
    expect(await answer(team.token, runId, "A")).toBe("late");
    expect((await board())[0].points).toBe(0);
  });

  it("gives 4 points 5 seconds in", async () => {
    const team = await join("AAA", "t");
    const runId = await run(questions[0].id, 5);
    await answer(team.token, runId, "A");
    expect((await board())[0].points).toBe(4);
  });

  it("re-scores everyone when the admin changes an answer", async () => {
    const team = await join("AAA", "t");
    const runId = await run(questions[0].id, 0);
    await answer(team.token, runId, "B");
    expect((await board())[0].points).toBe(0);
    await db.from("questions").update({ correct_option: "B" }).eq("id", questions[0].id);
    expect((await board())[0].points).toBe(5);
    await db.from("questions").update({ correct_option: "A" }).eq("id", questions[0].id);
  });

  it("breaks a tie on points by correct answers, then by total time", async () => {
    const slow = await join("AAA", "slow");
    const fast = await join("BBB", "fast");
    const many = await join("CCC", "many");
    const first = await run(questions[0].id, 0);
    const second = await run(questions[1].id, 0);
    const third = await run(questions[2].id, 0);
    // slow and fast both get one 5-point answer; fast is quicker. many gets two answers worth 5 in total.
    await db.from("answers").insert([
      { run_id: first, team_id: slow.id, choice: "A", elapsed_ms: 3000, points_if_correct: 5 },
      { run_id: first, team_id: fast.id, choice: "A", elapsed_ms: 1000, points_if_correct: 5 },
      { run_id: second, team_id: many.id, choice: "B", elapsed_ms: 9000, points_if_correct: 3 },
      { run_id: third, team_id: many.id, choice: "A", elapsed_ms: 13000, points_if_correct: 2 },
    ]);
    const rows = await board();
    expect(rows.map((r) => [r.name, r.rank])).toEqual([
      ["many", 1],
      ["fast", 2],
      ["slow", 3],
    ]);
  });

  it("gives equal ranks only to an exact tie", async () => {
    const one = await join("AAA", "one");
    const two = await join("BBB", "two");
    const runId = await run(questions[0].id, 0);
    await db.from("answers").insert([
      { run_id: runId, team_id: one.id, choice: "A", elapsed_ms: 2000, points_if_correct: 5 },
      { run_id: runId, team_id: two.id, choice: "A", elapsed_ms: 2000, points_if_correct: 5 },
    ]);
    expect((await board()).map((r) => r.rank)).toEqual([1, 1]);
  });

  it("refuses to start a question while another runs, or one already played", async () => {
    expect((await db.rpc("start_question", { p_question_id: questions[0].id })).data).toBe("started");
    expect((await db.rpc("start_question", { p_question_id: questions[1].id })).data).toBe("busy");
    await db.rpc("reset_question", { p_question_id: questions[0].id });
    await run(questions[0].id, 30);
    expect((await db.rpc("start_question", { p_question_id: questions[0].id })).data).toBe("already_played");
  });

  it("never puts the answer in the live state", async () => {
    await db.rpc("start_question", { p_question_id: questions[0].id });
    const { data } = await db.rpc("live_state");
    expect(JSON.stringify(data)).not.toContain("correct");
  });
});

describe("the content", () => {
  it("has the right number of questions, and the given answer key", async () => {
    const { data } = await db.from("questions").select("round_number, position, correct_option").order("round_number").order("position");
    const round = (n: number) => data!.filter((q) => q.round_number === n);
    expect(round(1).length).toBe(20);
    expect(round(2).length).toBe(10);
    expect(round(3).length).toBe(15);
    expect(round(4).length).toBe(10);
    expect(round(3).map((q) => q.correct_option).join("")).toBe("ABABABABABABABA");
    expect(round(4).map((q) => q.correct_option).join("")).toBe("BCBCBCBBCC");
  });

  it("has the user's Round 1 and 2 answers, and four options on each", async () => {
    const { data } = await db.from("questions").select("round_number, correct_option, options").in("round_number", [1, 2]).order("round_number").order("position");
    const key = (n: number) => data!.filter((q) => q.round_number === n).map((q) => q.correct_option).join(",");
    expect(key(1)).toBe("AI,REAL,REAL,AI,AI,AI,REAL,REAL,REAL,REAL,AI,AI,REAL,AI,REAL,AI,AI,REAL,REAL,AI");
    expect(key(2)).toBe("AI,REAL,REAL,AI,AI,AI,REAL,AI,AI,REAL");
    for (const question of data!) expect(question.options.length).toBe(4);
  });

  it("has the right time limits", async () => {
    const { data } = await db.from("rounds").select("number, time_limit_seconds").order("number");
    expect(data!.map((r) => r.time_limit_seconds)).toEqual([20, 20, 20, 25]);
  });
});
