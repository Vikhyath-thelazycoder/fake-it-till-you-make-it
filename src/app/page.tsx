"use client";

import { type Dispatch, type FormEvent, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { useCountdown, useLive } from "@/lib/live";
import { shuffled } from "@/lib/shuffle";
import type { LiveRun, RankingRow, Team } from "@/lib/types";

const TOKEN_KEY = "fake-it-token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private windows can refuse storage; the game still works until the page reloads.
  }
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  const onJoined = useCallback((nextToken: string, nextTeam: Team) => {
    writeToken(nextToken);
    setToken(nextToken);
    setTeam(nextTeam);
  }, []);

  const onSignedOut = useCallback(() => {
    writeToken(null);
    setToken(null);
    setTeam(null);
  }, []);

  if (!ready) return <main className="phone" />;
  if (!token) return <Join onJoined={onJoined} />;
  return <Game token={token} team={team} setTeam={setTeam} onSignedOut={onSignedOut} />;
}

function Join({ onJoined }: { onJoined: (token: string, team: Team) => void }) {
  const [mode, setMode] = useState<"join" | "rejoin">("join");
  const [code, setCode] = useState("");
  const [teamName, setTeamName] = useState("");
  const [leaderName, setLeaderName] = useState("");
  const [members, setMembers] = useState(["", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(mode === "join" ? "/api/join" : "/api/rejoin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "join" ? { code, teamName, leaderName, members } : { code, leaderName }),
      });
      const data = await response.json();
      if (!response.ok) setError(data.error ?? "Please try again.");
      else onJoined(data.token, data.team);
    } catch {
      setError("Can't reach the game. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="phone">
      <section className="hero">
        <h1>Fake It Till U Make It</h1>
        <p>Can your crew spot what&apos;s real?</p>
      </section>

      <form className="form" onSubmit={submit}>
        {mode === "join" && (
          <div>
            <label htmlFor="crew">Crew name</label>
            <input id="crew" value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={40} required autoComplete="off" />
          </div>
        )}
        <div>
          <label htmlFor="code">Secret code (on your player card)</label>
          <input
            id="code"
            className="mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={12}
            required
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="leader">Team leader&apos;s name</label>
          <input id="leader" value={leaderName} onChange={(e) => setLeaderName(e.target.value)} maxLength={40} required autoComplete="off" />
        </div>
        {mode === "join" &&
          members.map((member, index) => (
            <div key={index}>
              <label htmlFor={`member-${index}`}>Participant {index + 2}</label>
              <input
                id={`member-${index}`}
                value={member}
                onChange={(e) => setMembers(members.map((m, i) => (i === index ? e.target.value : m)))}
                maxLength={40}
                required
                autoComplete="off"
              />
            </div>
          ))}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "One moment…" : mode === "join" ? "Enter the game" : "Log back in"}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "join" ? "rejoin" : "join");
            setError(null);
          }}
        >
          {mode === "join" ? "Phone changed? Log back in" : "New crew? Join the game"}
        </button>
      </form>
    </main>
  );
}

function Game({
  token,
  team,
  setTeam,
  onSignedOut,
}: {
  token: string;
  team: Team | null;
  setTeam: Dispatch<SetStateAction<Team | null>>;
  onSignedOut: () => void;
}) {
  const { live, connected, clockOffset } = useLive();
  const runId = live?.run?.id ?? null;
  const [lockedRun, setLockedRun] = useState<string | null>(null);
  const [meFailed, setMeFailed] = useState(false);
  const gameId = live?.gameId;
  const teamGameId = team?.gameId;

  // Who we are. Read once when the page opens; retries wait longer each time.
  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const response = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
        if (stopped) return;
        if (response.status === 401) {
          onSignedOut();
          return;
        }
        if (!response.ok) throw new Error(`me ${response.status}`);
        const data = await response.json();
        if (stopped) return;
        setMeFailed(false);
        setTeam(data.team);
      } catch {
        if (stopped) return;
        setMeFailed(true);
        attempt += 1;
        timer = setTimeout(load, Math.min(2000 * 2 ** attempt, 30000) * (0.7 + Math.random() * 0.6));
      }
    }
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, setTeam, onSignedOut]);

  // New Game: this phone's crew belongs to the old game.
  useEffect(() => {
    if (gameId && teamGameId && gameId !== teamGameId) onSignedOut();
  }, [gameId, teamGameId, onSignedOut]);

  // Page reloaded in the middle of a question: ask once whether it was already answered.
  // Questions that arrive while the page is open need no lookup.
  const reloadChecked = useRef(false);
  const liveKnown = !!live;
  useEffect(() => {
    if (!liveKnown || reloadChecked.current) return;
    reloadChecked.current = true;
    if (!runId) return;
    fetch(`/api/me?run=${runId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.answeredChoice) setLockedRun(runId);
      })
      .catch(() => undefined);
  }, [liveKnown, runId, token]);

  const countdown = useCountdown(live?.run?.deadlineAt ?? null, clockOffset);
  const showQuestion = !!live?.run && countdown > 0 && lockedRun !== live.run.id;

  return (
    <main className="phone">
      <header className="topbar">
        <span className="brand">Fake It Till U Make It</span>
        {team && <span className="crew">{team.name}</span>}
      </header>

      {(!connected || meFailed) && (
        <div className="reconnecting" role="status">
          Reconnecting… don&apos;t refresh, you&apos;re still in the game.
        </div>
      )}

      {live?.published ? (
        <Final teamId={team?.id ?? null} />
      ) : !live ? (
        <Notice title="Connecting…" />
      ) : showQuestion && live.run ? (
        <Question
          key={live.run.id}
          run={live.run}
          countdown={countdown}
          token={token}
          onLocked={() => setLockedRun(live.run!.id)}
          onSignedOut={onSignedOut}
        />
      ) : live.run && lockedRun === live.run.id ? (
        <Notice badge={countdown > 0 ? `${countdown} s left` : undefined} title="Answer locked" text="Nice. Wait for the next question." />
      ) : live.run ? (
        <Notice title="Time's up" text="Eyes on the screen. The next question is coming." />
      ) : (
        <Notice
          title="The game hasn't started yet"
          text="Sit tight. The admin will start Round 1 soon."
          members={team ? [team.leaderName, ...team.members] : undefined}
        />
      )}
    </main>
  );
}

function Notice({ title, text, badge, members }: { title: string; text?: string; badge?: string; members?: string[] }) {
  return (
    <section className="notice">
      {badge && <span className="badge">{badge}</span>}
      <h1>{title}</h1>
      {text && <p className="muted">{text}</p>}
      {members && (
        <ul className="members">
          {members.map((member, index) => (
            <li key={index}>{member}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Question({
  run,
  countdown,
  token,
  onLocked,
  onSignedOut,
}: {
  run: LiveRun;
  countdown: number;
  token: string;
  onLocked: () => void;
  onSignedOut: () => void;
}) {
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function answer(choice: string) {
    if (sending) return;
    setSending(choice);
    setFailed(false);
    // A repeat of the same answer is safe: the server keeps only the first one.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ runId: run.id, choice }),
        });
        if (response.status === 401) {
          onSignedOut();
          return;
        }
        if (response.ok) {
          onLocked();
          return;
        }
        if (response.status < 500) break;
      } catch {
        // Network trouble: fall through and retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt * (0.7 + Math.random() * 0.6)));
    }
    setSending(null);
    setFailed(true);
  }

  const twoChoices = run.options.length === 2;
  // The question order is the same for everyone; each team's options are jumbled. Letters
  // follow the position on this phone, and the answer sent is always the option's own key.
  const options = shuffled(run.options, `${token}:${run.id}`);

  return (
    <section className="question">
      <div className="question-meta">
        <div>
          <div className="brand">
            Round {run.round} · {run.roundName}
          </div>
          <div className="muted">
            Question {run.number} of {run.total}
          </div>
        </div>
        <div className={`timer${countdown <= 5 ? " warn" : ""}`} aria-label={`${countdown} seconds left`}>
          {countdown}
        </div>
      </div>

      {run.title && <h2>{run.title}</h2>}
      {run.hint && <div className="muted">{run.hint}</div>}
      {run.body && <p className="scenario">{run.body}</p>}
      <div style={{ fontWeight: 700 }}>{run.prompt}</div>

      {failed && (
        <div className="error" role="alert">
          That didn&apos;t send. Tap your answer again.
        </div>
      )}

      <div className={`choices${twoChoices ? " two" : ""}`}>
        {options.map((option, index) => (
          <button key={option.key} disabled={!!sending} onClick={() => answer(option.key)}>
            {!twoChoices && <span className="key">{String.fromCharCode(65 + index)}</span>}
            <span>{sending === option.key ? "Sending…" : option.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Final({ teamId }: { teamId: string | null }) {
  const [mine, setMine] = useState<RankingRow | null>(null);

  useEffect(() => {
    fetch("/api/results")
      .then((response) => response.json())
      .then((data: { ranking: RankingRow[] }) => setMine(data.ranking.find((row) => row.teamId === teamId) ?? null))
      .catch(() => undefined);
  }, [teamId]);

  return (
    <Notice
      badge={mine ? `${mine.points} points` : undefined}
      title={mine ? `You came ${ordinal(mine.rank)}` : "Game over"}
      text="Look at the main screen for the winners."
    />
  );
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
