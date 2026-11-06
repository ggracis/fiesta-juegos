const base = import.meta.env.BASE_URL;

// Plan B: ?api=http://<notebook>:3000/ points every public call at the notebook (empty clears); ?token= is the PANEL_TOKEN
// for staff-only panel calls (cookies don't cross origins). Both persist in localStorage and are stripped from the URL.
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} } };
{
  const q = new URLSearchParams(location.search);
  const api = q.get('api');
  if (api !== null) ls.set('fiesta.api', /^https?:\/\//.test(api) ? api.replace(/\/?$/, '/') : '');
  if (q.has('token')) ls.set('fiesta.token', q.get('token'));
  if (api !== null || q.has('token')) { q.delete('api'); q.delete('token'); history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + location.hash); }
}
export const apiBase = () => ls.get('fiesta.api') || base;

// body: object -> JSON, string -> text/csv. method defaults to POST with a body, else GET.
async function call(path, body, method = body === undefined ? 'GET' : 'POST', extra) {
  let r;
  const init = { method, signal: AbortSignal.timeout(8000) };
  if (extra) init.headers = extra;
  if (typeof body === 'string') { init.headers = { ...extra, 'content-type': 'text/csv' }; init.body = body; }
  else if (body !== undefined) { init.headers = { ...extra, 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const root = path.startsWith('api/admin') ? base : apiBase(); // staff pages stay same-origin (cookie)
  try { r = await fetch(root + path, init); } catch { throw Object.assign(new Error('network'), { code: 'network' }); }
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'http'), { ...d, code: d.error || 'http', status: r.status });
  return d;
}
const e = encodeURIComponent;
const notFound = (x) => x.catch((err) => { if (err.code === 'not_found') return null; throw err; });

// Staff-only: the staff cookie (same origin) or, when a notebook is the API, the PANEL_TOKEN header.
const staff = () => { const t = ls.get('fiesta.token'); return t ? { 'x-panel-token': t } : undefined; };
export const panelRoster = () => call('api/panel/roster', undefined, 'GET', staff());
export const panelSync = (items) => call('api/panel/sync', { items }, 'POST', staff());

export const lookup = (name) => call('api/lookup', { name });
export const register = (name, dni, email, dietary) => call('api/register', { name, dni, email, dietary }); // undefined keys are dropped (name_only has no dni/email)
export const ticket = (token) => notFound(call('api/ticket/' + e(token)));
export const login = (pin, screenId) => call('api/login', { pin, screenId });
export const startAttempt = (session, game) => call('api/attempts', { session, game });
export const finishAttempt = (id, score, durationMs) => call(`api/attempts/${encodeURIComponent(id)}/result`, { score, durationMs });
export const rounds = (id, session) => call(`api/attempts/${e(id)}/rounds?session=${e(session)}`);
export const answer = (id, session, index, choice, ms) => call(`api/attempts/${e(id)}/answer`, { session, index, choice, ms });
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
export const adminContent = (kind) => call('api/admin/content/' + e(kind));
export const adminImportContent = (kind, csvText) => call(`api/admin/content/${e(kind)}/import`, csvText);
export const adminDeleteContent = (kind, id) => call(`api/admin/content/${e(kind)}/${e(id)}`, undefined, 'DELETE');
export const adminGuests = (q = '') => call('api/admin/guests?q=' + e(q));
export const adminImportGuests = (csvText) => call('api/admin/guests/import', csvText);
export const adminGuest = (id) => call('api/admin/guests/' + e(id));
export const adminCheckinGuest = (id) => call('api/admin/guests/' + e(id) + '/checkin', undefined, 'POST');
export const adminWalkIn = (id) => call('api/admin/guests/' + e(id) + '/walkin', undefined, 'POST');
export const adminAddGuest = (guest) => call('api/admin/guests', guest);
export const adminVerifications = () => call('api/admin/verifications?status=pending');
export const adminApproveVerification = (id, guestId) => call('api/admin/verifications/' + e(id) + '/approve', { guestId });
export const adminRejectVerification = (id) => call('api/admin/verifications/' + e(id) + '/reject', undefined, 'POST');
export const adminRanking = (game) => call('api/admin/ranking/' + e(game));
export const adminRaffle = () => call('api/admin/raffle', undefined, 'POST');
export const adminWinners = () => call('api/admin/raffle');
export const adminHideRaffle = () => call('api/admin/raffle/hide', undefined, 'POST');
