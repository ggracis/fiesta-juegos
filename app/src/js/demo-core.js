// Pure helpers behind the static (demo) backend. No DOM, no storage: state is passed in.
import { matchesName, verify, dniDigits, normEmail } from '../shared/identity.js';

export const MAX_FAILS = 5;
export const LOCK_MS = 30_000;

// Same contracts as POST /api/lookup and POST /api/register; the caller stores pending requests.
export const lookupRoster = (roster, name) => ({ found: roster.some((g) => matchesName(g.name, name)) });

export function registerRoster(roster, { name, dni, email }, mode) {
  const r = verify(roster.filter((g) => matchesName(g.name, name)), { dni, email }, mode);
  if (r.guest) return { status: 'registered', ticketToken: r.guest.ticketToken };
  return { status: 'pending', request: { name: name.trim(), dni: dniDigits(dni), email: normEmail(email), candidates: r.pending, createdAt: Date.now() } };
}

// fails: { [screenId]: { n, until } }, mutated in place. Same contract as POST /api/login.
export function checkPin(roster, fails, pin, screenId, now = Date.now()) {
  const f = fails[screenId] ?? { n: 0, until: 0 };
  if (f.until > now) return { error: 'locked', retryAfter: Math.ceil((f.until - now) / 1000) };
  const guest = roster.find((g) => g.pin === pin);
  if (guest) { delete fails[screenId]; return { guest }; }
  f.n++;
  if (f.n >= MAX_FAILS) { f.n = 0; f.until = now + LOCK_MS; }
  fails[screenId] = f;
  const locked = f.until > now;
  return { error: 'wrong_pin', remaining: locked ? 0 : MAX_FAILS - f.n, locked, retryAfter: locked ? LOCK_MS / 1000 : 0 };
}
