"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

type CardTeam = { id: string; code: string };

// The sheet of player cards: a QR to the site and the team's secret code.
export default function CardsPage() {
  const [teams, setTeams] = useState<CardTeam[] | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    QRCode.toString(window.location.origin, { type: "svg", margin: 1 }).then(setQr).catch(() => setError("Could not make the QR code."));
    fetch("/api/admin/state")
      .then(async (response) => {
        if (!response.ok) throw new Error("Please log in to the admin panel first.");
        const data = await response.json();
        setTeams(data.teams);
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <main className="admin">
      <div className="admin-head no-print">
        <h1>Player cards</h1>
        <div className="row">
          <a href="/admin">Back to admin</a>
          <button onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {teams && teams.length === 0 && <p>No team codes yet. Make them on the Teams tab.</p>}
      <div className="cards">
        {teams?.map((team) => (
          <div className="card" key={team.id}>
            <h3>Fake It Till U Make It</h3>
            <div className="muted">Scan to join, then enter your secret code</div>
            <div dangerouslySetInnerHTML={{ __html: qr }} />
            <div className="muted">Secret code</div>
            <div className="mono">{team.code}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
