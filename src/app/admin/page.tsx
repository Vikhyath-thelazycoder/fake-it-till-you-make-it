"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { formatMs, type Option } from "@/lib/types";

type Round = { number: number; name: string; time_limit_seconds: number };
type Question = {
  id: string;
  round_number: number;
  position: number;
  title: string | null;
  hint: string | null;
  prompt: string;
  body: string | null;
  options: Option[];
  correct_option: string | null;
};
type TeamRow = { id: string; code: string; name: string | null; leader_name: string | null; members: string[] | null };
type Run = { id: string; question_id: string; started_at: string; deadline_at: string; answers: { count: number }[] };
type AdminState = {
  game: { id: string; results_published_at: string | null };
  rounds: Round[];
  questions: Question[];
  teams: TeamRow[];
  runs: Run[];
  now: number;
};
type BoardRow = {
  team_id: string;
  name: string;
  leader_name: string;
  members: string[];
  points: number;
  correct: number;
  answered: number;
  total_ms: number;
  round_points: Record<string, number>;
  rank: number;
};
type Tab = "game" | "questions" | "teams" | "results";

const POLL_MS = 2000;

async function send(method: string, path: string, body?: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/admin${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({}));
    return { ok: false, error: data.error ?? "That didn't work. Try again." };
  } catch {
    return { ok: false, error: "Can't reach the server. Try again." };
  }
}

export default function AdminPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [tab, setTab] = useState<Tab>("game");
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/state");
      if (response.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!response.ok) throw new Error();
      const data = (await response.json()) as AdminState;
      setState(data);
      setClockOffset(data.now - Date.now());
      setNeedsLogin(false);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const act = useCallback(
    async (method: string, path: string, body?: unknown): Promise<boolean> => {
      setError(null);
      const result = await send(method, path, body);
      if (!result.ok) setError(result.error);
      await refresh();
      return result.ok;
    },
    [refresh],
  );

  if (needsLogin) return <Login onDone={refresh} />;
  if (!state) return <main className="admin">{offline ? "Can't reach the server. Retrying…" : "Loading…"}</main>;

  return (
    <main className="admin">
      <header className="admin-head">
        <h1>Fake It Till U Make It admin</h1>
        <div className="row">
          {offline && <span className="chip off">Reconnecting…</span>}
          <a href="/results" target="_blank" rel="noreferrer">
            Results page ↗
          </a>
          <button
            className="small secondary"
            onClick={async () => {
              await send("POST", "/logout");
              setNeedsLogin(true);
            }}
          >
            Log out
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {(
          [
            ["game", "Run game"],
            ["questions", "Questions & answers"],
            ["teams", `Teams (${state.teams.filter((t) => t.name).length}/${state.teams.length})`],
            ["results", "Results"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="error" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {tab === "game" && <RunGame state={state} act={act} clockOffset={clockOffset} />}
      {tab === "questions" && <Questions state={state} act={act} />}
      {tab === "teams" && <Teams state={state} act={act} />}
      {tab === "results" && <Results state={state} act={act} />}
    </main>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await send("POST", "/login", { passcode });
    if (result.ok) await onDone();
    else setError(result.error);
  }

  return (
    <main className="phone">
      <section className="hero">
        <h1>Admin</h1>
      </section>
      <form className="form" onSubmit={submit}>
        <div>
          <label htmlFor="passcode">Passcode</label>
          <input id="passcode" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} required autoComplete="current-password" />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="primary">Log in</button>
      </form>
    </main>
  );
}

type Act = (method: string, path: string, body?: unknown) => Promise<boolean>;

function questionLabel(question: Question, index: number): string {
  return question.title ?? `Question ${index + 1}`;
}

function RunGame({ state, act, clockOffset }: { state: AdminState; act: Act; clockOffset: number }) {
  const [round, setRound] = useState(1);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(interval);
  }, []);

  const serverNow = now + clockOffset;
  const runByQuestion = new Map(state.runs.map((run) => [run.question_id, run]));
  const active = state.runs.find((run) => Date.parse(run.deadline_at) > serverNow);
  const activeQuestion = active ? state.questions.find((q) => q.id === active.question_id) : undefined;
  const joined = state.teams.filter((team) => team.name).length;
  const questions = state.questions.filter((q) => q.round_number === round);
  const nextQuestion = questions.find((q) => !runByQuestion.has(q.id));
  const missing = state.questions.filter((q) => !q.correct_option).length;

  return (
    <>
      {missing > 0 && (
        <div className="warning">
          {missing} questions have no answer yet. They score 0 until you add the answer on the Questions tab. Adding it later still re-scores everyone.
        </div>
      )}

      <section className="panel live-panel" aria-live="polite">
        {active && activeQuestion ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div>
                Round {activeQuestion.round_number}: {activeQuestion.title ?? activeQuestion.prompt}
              </div>
              <div className="live-count">{Math.ceil((Date.parse(active.deadline_at) - serverNow) / 1000)} s</div>
            </div>
            <div>
              <div>Answered</div>
              <div className="live-count">
                {active.answers[0]?.count ?? 0}/{joined}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div>No question running. {joined} teams joined.</div>
            {nextQuestion && (
              <button
                style={{ background: "var(--apricot)", color: "var(--plum)", marginTop: 10, fontSize: 20 }}
                onClick={() => act("POST", "/runs", { questionId: nextQuestion.id })}
              >
                Start Round {round}: {questionLabel(nextQuestion, questions.indexOf(nextQuestion))}
              </button>
            )}
          </div>
        )}
      </section>

      <div className="tabs">
        {state.rounds.map((r) => (
          <button key={r.number} aria-selected={round === r.number} onClick={() => setRound(r.number)}>
            Round {r.number}: {r.name} ({r.time_limit_seconds} s)
          </button>
        ))}
      </div>

      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Status</th>
              <th className="num">Answers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {questions.map((question, index) => {
              const run = runByQuestion.get(question.id);
              const running = run && Date.parse(run.deadline_at) > serverNow;
              return (
                <tr key={question.id}>
                  <td>
                    {index + 1}. {question.title ?? question.prompt}
                  </td>
                  <td>
                    <span className={`chip${run ? "" : " off"}`}>{running ? "Running" : run ? "Played" : "Not played"}</span>
                  </td>
                  <td className="num">{run ? (run.answers[0]?.count ?? 0) : "–"}</td>
                  <td className="num">
                    {run ? (
                      <button
                        className="small secondary"
                        onClick={() => {
                          if (window.confirm("Reset this question? Every team's answer to it is deleted.")) {
                            void act("POST", `/runs/${question.id}/reset`);
                          }
                        }}
                      >
                        Reset
                      </button>
                    ) : (
                      <button className="small" disabled={!!active} onClick={() => act("POST", "/runs", { questionId: question.id })}>
                        Start
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Questions({ state, act }: { state: AdminState; act: Act }) {
  const [round, setRound] = useState(1);
  const [bulk, setBulk] = useState("");
  const questions = state.questions.filter((q) => q.round_number === round);

  return (
    <>
      <div className="tabs">
        {state.rounds.map((r) => (
          <button key={r.number} aria-selected={round === r.number} onClick={() => setRound(r.number)}>
            Round {r.number}: {r.name}
          </button>
        ))}
      </div>

      <section className="panel">
        <h2>Paste all answers for this round</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          In order, one per question, separated by commas or new lines. {round <= 2 ? "Use AI or Real." : "Use the option letters."} This round has{" "}
          {questions.length} questions.
        </p>
        <textarea rows={3} value={bulk} onChange={(e) => setBulk(e.target.value)} aria-label="Answers" />
        <button
          style={{ marginTop: 10 }}
          disabled={!bulk.trim()}
          onClick={async () => {
            const answers = bulk.split(/[\s,]+/).filter(Boolean);
            if (await act("POST", "/answers/bulk", { round, answers })) setBulk("");
          }}
        >
          Save answers
        </button>
      </section>

      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Question</th>
              <th>Answer</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {questions.map((question, index) => (
              <tr key={question.id}>
                <td>{index + 1}</td>
                <td className="q-text">
                  {question.title && <strong>{question.title}. </strong>}
                  {question.body ? `${question.body} ` : ""}
                  <span className="muted">{question.prompt}</span>
                </td>
                <td style={{ minWidth: 170 }}>
                  <select
                    aria-label={`Answer for question ${index + 1}`}
                    value={question.correct_option ?? ""}
                    onChange={(e) => act("PATCH", `/questions/${question.id}`, { correctOption: e.target.value || null })}
                  >
                    <option value="">No answer yet</option>
                    {question.options.map((option) => (
                      <option key={option.key} value={option.key}>
                        {question.options.length === 2 ? option.label : `${option.key}. ${option.label}`}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  <button
                    className="small secondary"
                    onClick={() => {
                      if (window.confirm(`Remove question ${index + 1}?`)) void act("DELETE", `/questions/${question.id}`);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <AddQuestion key={round} round={round} sample={questions[0]} count={questions.length} act={act} />
    </>
  );
}

function AddQuestion({ round, sample, count, act }: { round: number; sample?: Question; count: number; act: Act }) {
  const fixedOptions = round <= 3 && sample ? sample.options : null;
  const [title, setTitle] = useState(round === 1 ? `Image ${count + 1}` : round === 2 ? `Video ${count + 1}` : "");
  const [prompt, setPrompt] = useState(round <= 3 ? (sample?.prompt ?? "") : "");
  const [body, setBody] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [correct, setCorrect] = useState("");

  const usedOptions: Option[] = fixedOptions ?? ["A", "B", "C", "D"].map((key, index) => ({ key, label: options[index] }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await act("POST", "/questions", {
      round,
      title: title.trim() || null,
      prompt,
      body: body.trim() || null,
      options: usedOptions,
      correctOption: correct || null,
    });
    if (ok) {
      setBody("");
      setOptions(["", "", "", ""]);
      setCorrect("");
      setTitle(round === 1 ? `Image ${count + 2}` : round === 2 ? `Video ${count + 2}` : "");
    }
  }

  return (
    <section className="panel">
      <h2>Add a question to this round</h2>
      <form className="form" onSubmit={submit}>
        <div>
          <label htmlFor="new-title">Title</label>
          <input id="new-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        {round >= 3 && (
          <div>
            <label htmlFor="new-body">{round === 3 ? "Text" : "Situation"}</label>
            <textarea id="new-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required={round === 3} />
          </div>
        )}
        <div>
          <label htmlFor="new-prompt">Question</label>
          <input id="new-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
        </div>
        {!fixedOptions &&
          ["A", "B", "C", "D"].map((key, index) => (
            <div key={key}>
              <label htmlFor={`new-option-${key}`}>Option {key}</label>
              <input
                id={`new-option-${key}`}
                value={options[index]}
                onChange={(e) => setOptions(options.map((o, i) => (i === index ? e.target.value : o)))}
                required
              />
            </div>
          ))}
        <div>
          <label htmlFor="new-correct">Answer</label>
          <select id="new-correct" value={correct} onChange={(e) => setCorrect(e.target.value)}>
            <option value="">No answer yet</option>
            {usedOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {usedOptions.length === 2 ? option.label : `${option.key}${option.label ? `. ${option.label}` : ""}`}
              </option>
            ))}
          </select>
        </div>
        <button className="primary">Add question</button>
      </form>
    </section>
  );
}

function Teams({ state, act }: { state: AdminState; act: Act }) {
  const [count, setCount] = useState("70");

  return (
    <>
      <section className="panel">
        <h2>Team codes</h2>
        <div className="row">
          <input
            type="number"
            min={1}
            max={200}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            aria-label="How many team codes"
            style={{ width: 110 }}
          />
          <button onClick={() => act("POST", "/teams/generate", { count: Number(count) })}>Make codes</button>
          <a href="/admin/cards" target="_blank" rel="noreferrer">
            Print player cards ↗
          </a>
        </div>
      </section>
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Crew</th>
              <th>Members</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.teams.map((team) => (
              <tr key={team.id}>
                <td className="mono">{team.code}</td>
                <td style={{ overflowWrap: "anywhere" }}>{team.name ?? <span className="chip off">Not joined</span>}</td>
                <td style={{ overflowWrap: "anywhere" }}>{team.name ? [team.leader_name, ...(team.members ?? [])].join(", ") : ""}</td>
                <td className="num">
                  <button
                    className="small secondary"
                    onClick={() => {
                      if (window.confirm(`Remove ${team.name ?? team.code}? Their answers are deleted too.`)) {
                        void act("DELETE", `/teams/${team.id}`);
                      }
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Results({ state, act }: { state: AdminState; act: Act }) {
  const [board, setBoard] = useState<BoardRow[] | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const published = !!state.game.results_published_at;
  const gameId = state.game.id;

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/results");
    if (response.ok) setBoard((await response.json()).ranking);
  }, []);

  useEffect(() => {
    void load();
  }, [load, gameId, published]);

  return (
    <>
      <section className="panel">
        <h2>Announce</h2>
        <div className="row">
          <button onClick={load} className="secondary">
            Refresh scores
          </button>
          {published ? (
            <button className="secondary" onClick={() => act("POST", "/publish", { published: false })}>
              Hide results
            </button>
          ) : (
            <button
              onClick={() => {
                if (window.confirm("Show the results on the results page and every phone?")) {
                  void act("POST", "/publish", { published: true });
                }
              }}
            >
              Publish results
            </button>
          )}
          <span className={`chip${published ? "" : " off"}`}>{published ? "Published" : "Hidden"}</span>
        </div>
      </section>

      <section className="panel table-wrap">
        <h2>Ranking</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Most points, then most correct answers, then least total time on correct answers.
        </p>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Crew</th>
              <th className="num">Points</th>
              <th className="num">R1</th>
              <th className="num">R2</th>
              <th className="num">R3</th>
              <th className="num">R4</th>
              <th className="num">Correct</th>
              <th className="num">Time</th>
            </tr>
          </thead>
          <tbody>
            {board?.map((row) => (
              <tr key={row.team_id}>
                <td>{row.rank}</td>
                <td style={{ overflowWrap: "anywhere" }}>{row.name}</td>
                <td className="num">
                  <strong>{row.points}</strong>
                </td>
                {["1", "2", "3", "4"].map((round) => (
                  <td className="num" key={round}>
                    {row.round_points[round]}
                  </td>
                ))}
                <td className="num">{row.correct}</td>
                <td className="num">{formatMs(row.total_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>New game</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Starts over with no teams and new codes. Questions and answers stay. Phones in this game are logged out. Type NEW GAME to confirm.
        </p>
        <div className="row">
          <input className="grow" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="Type NEW GAME to confirm" />
          <button
            className="danger"
            disabled={confirmText !== "NEW GAME"}
            onClick={async () => {
              if (await act("POST", "/new-game", { confirm: confirmText })) setConfirmText("");
            }}
          >
            New game
          </button>
        </div>
      </section>
    </>
  );
}
