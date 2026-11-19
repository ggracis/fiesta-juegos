// Name/email matching, shared by the Fastify server and the static demo core. Pure, no DOM, no storage.
// ponytail: this becomes a per-event setting in the upcoming Supabase admin panel.
// 'name_email': a name match plus an equal normalized email registers. 'name_only': a unique name match registers directly.
export const VALIDATION_MODE = 'name_email';

// Lowercase, no accents, no punctuation, single spaces -> tokens.
export const nameTokens = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);

// Typed name matches when it has >= 2 distinct tokens and all of them appear in the roster name.
export function matchesName(rosterName, typed) {
  const have = new Set(nameTokens(rosterName)), want = new Set(nameTokens(typed));
  return want.size >= 2 && [...want].every((t) => have.has(t));
}

export const normEmail = (s) => String(s ?? '').trim().toLowerCase();
export const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(s));
// One roster row from raw cells: column A is the name, the email is the first other cell with an "@" (also reads legacy name,dni,email files).
export const guestRow = (cells) => ({
  name: String(cells[0] ?? '').replace(/\s+/g, ' ').trim(),
  email: normEmail(cells.slice(1).find((c) => String(c ?? '').includes('@'))),
});
export const cleanDietary = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).trimEnd() || null; // free text: collapsed, capped, '' -> null

// rows: roster guests whose name matched. Returns { guest } to register, or { pending: candidate ids } for staff verification.
export function verify(rows, { email }, mode = VALIDATION_MODE) {
  const guest = mode === 'name_only'
    ? (rows.length === 1 ? rows[0] : undefined)
    : rows.find((g) => normEmail(email) && normEmail(g.email) === normEmail(email));
  return guest ? { guest } : { pending: rows.map((g) => g.id) };
}
