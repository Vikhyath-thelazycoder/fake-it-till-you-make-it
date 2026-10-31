export type Option = { key: string; label: string };

export type LiveRun = {
  id: string;
  round: number;
  roundName: string;
  number: number;
  total: number;
  title: string | null;
  hint: string | null;
  prompt: string;
  body: string | null;
  options: Option[];
  startedAt: string;
  deadlineAt: string;
  limitSeconds: number;
};

export type LiveState = {
  gameId: string;
  version: number;
  published: boolean;
  run: LiveRun | null;
  v: string;
};

export type Team = {
  id: string;
  gameId?: string;
  name: string;
  leaderName: string;
  members: string[];
};

export type RankingRow = {
  teamId: string;
  name: string;
  points: number;
  correct: number;
  totalMs: number;
  rank: number;
};

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`;
}
