// Raffle show timeline, shared by the panels and the tests. Pure. Times in ms; offset = server clock - local clock.
// Every panel derives the same frame from (drawnAt, server time), so screens stay in step without talking to each other.
export const LEAD_MS = 3000; // panels poll every 1 s in raffle mode: the lead lets all of them see the draw before it starts
export const SUSPENSE_MS = 8000;
export const SCRAMBLE_MS = 70; // letters reshuffle at this pace during the suspense
export const LOCK_FROM = 0.5; // share of the suspense before the first letter locks into place

// phase: 'wait' (before start) | 'suspense' | 'reveal' (winner on screen) | 'done'; ms = time spent in that phase.
export function rafflePhase(localNow, offset, drawnAt, showMs) {
  const t = localNow + offset - (drawnAt + LEAD_MS);
  if (t < 0) return { phase: 'wait', ms: t };
  if (t < SUSPENSE_MS) return { phase: 'suspense', ms: t };
  if (t < SUSPENSE_MS + showMs) return { phase: 'reveal', ms: t - SUSPENSE_MS };
  return { phase: 'done', ms: t - SUSPENSE_MS - showMs };
}

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const hash = (a, b, c) => { let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177); h = Math.imul(h ^ (h >>> 13), 1103515245); return (h ^ (h >>> 16)) >>> 0; };

// Random letters in the winner's shape (spaces and punctuation kept), locking left to right in the second half
// of the suspense and spelling `name` exactly at the end. Seeded by (seed, step, position): every panel shows the same letters.
export function scramble(ms, name, seed) {
  const p = Math.min(1, Math.max(0, ms / SUSPENSE_MS)), step = Math.floor(ms / SCRAMBLE_MS), chars = [...name];
  return chars.map((c, i) => {
    if (!/\p{L}/u.test(c) || p >= LOCK_FROM + ((1 - LOCK_FROM) * (i + 1)) / chars.length) return c;
    const r = ABC[hash(seed, step, i) % 26];
    return c === c.toLowerCase() ? r.toLowerCase() : r;
  }).join('');
}
