"use client";

import { useEffect, useState } from "react";
import { formatMs, type RankingRow } from "@/lib/types";

const PLACES = ["1st place", "2nd place", "3rd place"];

// For the projector: the admin publishes, this page shows it.
export default function ResultsPage() {
  const [ranking, setRanking] = useState<RankingRow[] | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const response = await fetch("/api/results");
        const data = await response.json();
        if (!stopped) setRanking(data.published ? data.ranking : null);
      } catch {
        // Keep showing what we have and try again.
      }
      if (!stopped) timer = setTimeout(check, 3000);
    }
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <main className="results">
      <div className="results-inner">
        {!ranking ? (
          <h1>And the winners are…</h1>
        ) : (
          <>
            <h1>The winners</h1>
            <div className="podium">
              {ranking.slice(0, 3).map((row) => (
                <div key={row.teamId}>
                  <div className="place">{PLACES[row.rank - 1] ?? `Place ${row.rank}`}</div>
                  <div className="winner">{row.name}</div>
                  <div>{row.points} points</div>
                </div>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Crew</th>
                    <th className="num">Points</th>
                    <th className="num">Correct</th>
                    <th className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((row) => (
                    <tr key={row.teamId}>
                      <td>{row.rank}</td>
                      <td style={{ overflowWrap: "anywhere" }}>{row.name}</td>
                      <td className="num">{row.points}</td>
                      <td className="num">{row.correct}</td>
                      <td className="num">{formatMs(row.totalMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
