// Shared by server and client. Pure functions only.
export const ROUNDS = 10;
export const ROUND_TIMEOUT_MS = 8000;
export const MIN_TOTAL_MS = 3000;

export const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// < 1.5 s -> 10; -1 per extra 0.5 s; min 2 if found; not found -> 0; -2 per wrong tap (round floor 0).
export function roundScore({ found, ms, wrong = 0 }) {
  if (!found) return 0;
  const base = ms < 1500 ? 10 : Math.max(2, 10 - Math.floor((ms - 1000) / 500));
  return Math.max(0, base - 2 * wrong);
}

export const totalScore = (rounds) => clampScore(rounds.reduce((s, r) => s + roundScore(r), 0));
