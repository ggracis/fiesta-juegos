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

// Memo Test. Finish: 100 - max(0, s - freeSeconds) - wrongPenalty * wrong, never below finishFloor
// (so finishing beats any time-out). Time-out or idle: 5 per pair found.
export const MEMO_PAIRS = 8;
export const MEMO_MIN_MS = 8000; // 16 flips with animation can't be faster
export function memoScore({ finished, ms = 0, wrong = 0, pairs = 0 }, { freeSeconds, wrongPenalty, finishFloor }) {
  if (!finished) return clampScore(5 * Math.min(pairs, MEMO_PAIRS - 1));
  const s = Math.floor(ms / 1000);
  return clampScore(Math.max(finishFloor, 100 - Math.max(0, s - freeSeconds) - wrongPenalty * wrong));
}
