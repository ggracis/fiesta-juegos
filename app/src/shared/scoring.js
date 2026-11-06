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

// Pixel Revelado: correct within 2 s = 12, then −1 per started second, min 4; wrong or no answer = 0.
export const pixelPoints = (correct, ms) => (correct ? Math.max(4, 12 - Math.max(0, Math.ceil((ms - 2000) / 1000))) : 0);
// rounds: [{ correct, points }] answered so far; +4 only when all `total` rounds are correct (8 × 12 + 4 = 100).
export const PIXEL_BONUS = 4;
export const pixelTotal = (rounds, total) =>
  clampScore(rounds.reduce((s, r) => s + r.points, 0) + (total > 0 && rounds.length === total && rounds.every((r) => r.correct) ? PIXEL_BONUS : 0));

// Memo Test. Finish: 100 - max(0, s - freeSeconds) - wrongPenalty * wrong, never below finishFloor
// (so finishing beats any time-out). Time-out or idle: 5 per pair found.
export const MEMO_PAIRS = 8;
export const MEMO_MIN_MS = 8000; // 16 flips with animation can't be faster
export function memoScore({ finished, ms = 0, wrong = 0, pairs = 0 }, { freeSeconds, wrongPenalty, finishFloor }) {
  if (!finished) return clampScore(5 * Math.min(pairs, MEMO_PAIRS - 1));
  const s = Math.floor(ms / 1000);
  return clampScore(Math.max(finishFloor, 100 - Math.max(0, s - freeSeconds) - wrongPenalty * wrong));
}

// Quiz, per question: correct = 6 + round(4 × secondsLeft / limit); wrong or no answer = 0 (10 × 10 = 100 max).
// ms is clamped to [0, limit]; under QUIZ_MIN_MS a tap is implausible and earns no speed bonus.
export const QUIZ_MIN_MS = 400;
export function quizPoints(correct, ms, params) {
  if (!correct) return 0;
  const limit = (Number(params?.secondsPerQuestion) || 12) * 1000;
  const t = Math.max(0, Math.min(limit, Number(ms) || 0));
  return t < QUIZ_MIN_MS ? 6 : 6 + Math.round((4 * (limit - t)) / limit);
}
