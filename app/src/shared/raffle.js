// Raffle show timeline, shared by the panels and the tests. Pure. Times in ms; offset = server clock - local clock.
// Every panel derives the same frame from (drawnAt, server time), so screens stay in step without talking to each other.
export const LEAD_MS = 3000; // panels poll every 1 s in raffle mode: the lead lets all of them see the draw before it starts
export const SUSPENSE_MS = 8000;
export const REEL_STEPS = 48; // names shown during the suspense

// phase: 'wait' (before start) | 'suspense' | 'reveal' (winner on screen) | 'done'; ms = time spent in that phase.
export function rafflePhase(localNow, offset, drawnAt, showMs) {
  const t = localNow + offset - (drawnAt + LEAD_MS);
  if (t < 0) return { phase: 'wait', ms: t };
  if (t < SUSPENSE_MS) return { phase: 'suspense', ms: t };
  if (t < SUSPENSE_MS + showMs) return { phase: 'reveal', ms: t - SUSPENSE_MS };
  return { phase: 'done', ms: t - SUSPENSE_MS - showMs };
}

// Slot-machine reel: fast at first, decelerating (ease-out cubic), landing on `winner` (index into the sample) at the end.
export function reelIndex(ms, n, winner) {
  const p = Math.min(1, Math.max(0, ms / SUSPENSE_MS));
  const step = Math.floor(REEL_STEPS * (1 - (1 - p) ** 3));
  return (((winner - REEL_STEPS + step) % n) + n) % n;
}
