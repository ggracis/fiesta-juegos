// Name/DNI/email matching, shared by the Fastify server and the static demo core. Pure, no DOM, no storage.
// ponytail: this becomes a per-event setting in the upcoming Supabase admin panel.
// 'name_dni_email': name + DNI + email must match one roster row. 'name_only': a unique name match registers directly.
export const VALIDATION_MODE = 'name_dni_email';

// Lowercase, no accents, no punctuation, single spaces -> tokens.
export const nameTokens = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);

// Typed name matches when it has >= 2 distinct tokens and all of them appear in the roster name.
export function matchesName(rosterName, typed) {
  const have = new Set(nameTokens(rosterName)), want = new Set(nameTokens(typed));
  return want.size >= 2 && [...want].every((t) => have.has(t));
}

export const dniDigits = (s) => String(s ?? '').replace(/\D/g, '');
export const formatDni = (s) => dniDigits(s).slice(0, 8).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); // 12.345.678 / 1.234.567
export const validDni = (s) => /^\d{7,8}$/.test(dniDigits(s));
export const normEmail = (s) => String(s ?? '').trim().toLowerCase();
export const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(s));

// rows: roster guests whose name matched. Returns { guest } to register, or { pending: candidate ids } for staff verification.
export function verify(rows, { dni, email }, mode = VALIDATION_MODE) {
  const guest = mode === 'name_only'
    ? (rows.length === 1 ? rows[0] : undefined)
    : rows.find((g) => dniDigits(g.dni) === dniDigits(dni) && normEmail(g.email) === normEmail(email));
  return guest ? { guest } : { pending: rows.map((g) => g.id) };
}
