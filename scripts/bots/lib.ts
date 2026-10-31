import { mkdirSync, writeFileSync } from "node:fs";

export const BASE = process.env.BOT_BASE ?? "http://localhost:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "";

// Bots wipe the game they run on, so they only run locally or on a project named for them.
export function refuseLiveGame(): void {
  const local = SUPABASE.includes("127.0.0.1");
  if (!local && process.env.BOT_TARGET_IS_TEST !== "yes") {
    throw new Error("Bots reset the game. Set BOT_TARGET_IS_TEST=yes only for a project with no real game on it.");
  }
}

export class Admin {
  private cookie = "";

  async login(): Promise<void> {
    const response = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: process.env.ADMIN_PASSCODE }),
    });
    if (!response.ok) throw new Error(`admin login ${response.status}`);
    this.cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  async call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${BASE}/api/admin${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.call(method, path, body);
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

export function writeReport(label: string, report: unknown): string {
  const dir = `docs/reports/runs/${label}`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/summary.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

// The user's points sheet again, by hand, independent of the database's formula.
export function sheetPoints(elapsedMs: number, limit: number): number {
  const shown = Math.max(1, Math.ceil((limit * 1000 - elapsedMs) / 1000));
  const bands =
    limit === 25
      ? [[21, 5], [16, 4], [11, 3], [6, 2], [1, 1]]
      : [[17, 5], [13, 4], [9, 3], [5, 2], [1, 1]];
  for (const [low, points] of bands) if (shown >= low) return points;
  return 0;
}
