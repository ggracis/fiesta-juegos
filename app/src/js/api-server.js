const base = import.meta.env.BASE_URL;

// body: object -> JSON, string -> text/csv. method defaults to POST with a body, else GET.
async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
  let r;
  const init = { method, signal: AbortSignal.timeout(8000) };
  if (typeof body === 'string') { init.headers = { 'content-type': 'text/csv' }; init.body = body; }
  else if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  try { r = await fetch(base + path, init); } catch { throw Object.assign(new Error('network'), { code: 'network' }); }
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'http'), { ...d, code: d.error || 'http', status: r.status });
  return d;
}
const e = encodeURIComponent;
const notFound = (x) => x.catch((err) => { if (err.code === 'not_found') return null; throw err; });

export const search = (q) => call('api/guests/search?q=' + encodeURIComponent(q));
export const register = (guestId) => call('api/register', { guestId });
export const ticket = (token) => notFound(call('api/ticket/' + e(token)));
export const login = (pin, screenId) => call('api/login', { pin, screenId });
export const startAttempt = (session, game) => call('api/attempts', { session, game });
export const finishAttempt = (id, score, durationMs) => call(`api/attempts/${encodeURIComponent(id)}/result`, { score, durationMs });
export function live({ screenId, game, session } = {}) {
  const qs = new URLSearchParams(Object.entries({ screenId, game, session }).filter(([, v]) => v)).toString();
  return call('api/live' + (qs ? '?' + qs : ''));
}
export const checkinInfo = (token) => notFound(call('api/checkin/' + e(token)));
export const checkinAction = (token, action) => call('api/admin/checkin/' + e(token), { action });

export const adminLogin = (password) => call('api/admin/login', { password });
export const adminLogout = () => call('api/admin/logout', undefined, 'POST');
export const adminMe = () => call('api/admin/me');
export const adminState = () => call('api/admin/state');
export const adminSettings = (patch) => call('api/admin/settings', patch, 'PUT');
export const adminGame = (id, patch) => call('api/admin/games/' + e(id), patch, 'PUT');
export const adminGuests = (q = '') => call('api/admin/guests?q=' + e(q));
export const adminImportGuests = (csvText) => call('api/admin/guests/import', csvText);
export const adminGuest = (id) => call('api/admin/guests/' + e(id));
export const adminCheckinGuest = (id) => call('api/admin/guests/' + e(id) + '/checkin', undefined, 'POST');
export const adminRanking = (game) => call('api/admin/ranking/' + e(game));
export const adminRaffle = () => call('api/admin/raffle', undefined, 'POST');
export const adminHideRaffle = () => call('api/admin/raffle/hide', undefined, 'POST');
