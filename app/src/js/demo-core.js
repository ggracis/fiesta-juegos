// Pure helpers behind the static (demo) backend. No DOM, no storage: state is passed in.
export const MAX_FAILS = 5;
export const LOCK_MS = 30_000;

export const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// registered: Set of guest ids. Same contract as GET /api/guests/search.
export function searchRoster(roster, registered, q) {
  const n = normalize(q);
  if (n.length < 3) return [];
  return roster.filter((g) => normalize(g.name).includes(n)).slice(0, 5)
    .map((g) => ({ id: g.id, name: g.name, registered: registered.has(g.id) }));
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
