// One API, two backends chosen at build time (VITE_DATA_MODE = server | static).
// Every call throws Error with .code ('rate_limited', 'invalid_input', 'wrong_pin', 'locked', 'network', ...).
export const isDemo = import.meta.env.VITE_DATA_MODE === 'static';

let impl;
const backend = () => (impl ??= isDemo ? import('./api-static.js') : import('./api-server.js'));
const call = (name) => async (...a) => (await backend())[name](...a);

export const lookup = call('lookup');
export const register = call('register');
export const ticket = call('ticket');
export const login = call('login');
export const startAttempt = call('startAttempt');
export const finishAttempt = call('finishAttempt');
export const live = call('live');
export const checkinInfo = call('checkinInfo');
export const checkinAction = call('checkinAction');
export const adminLogin = call('adminLogin');
export const adminLogout = call('adminLogout');
export const adminMe = call('adminMe');
export const adminState = call('adminState');
export const adminSettings = call('adminSettings');
export const adminGame = call('adminGame');
export const adminGuests = call('adminGuests');
export const adminImportGuests = call('adminImportGuests');
export const adminGuest = call('adminGuest');
export const adminCheckinGuest = call('adminCheckinGuest');
export const adminRanking = call('adminRanking');
export const adminRaffle = call('adminRaffle');
export const adminHideRaffle = call('adminHideRaffle');
export const attemptsCsvUrl = `${import.meta.env.BASE_URL}api/admin/attempts.csv`;

// Per-screen id: venue panels share one public IP, so lockouts are keyed by this instead.
export function screenId() {
  try {
    let id = localStorage.getItem('fiesta.screen');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('fiesta.screen', id); }
    return id;
  } catch { return (screenId.fallback ??= crypto.randomUUID()); }
}

// Pages live in the same folder in both modes, so relative URLs work under any base path.
export const ticketHref = (token) => `ticket.html?t=${encodeURIComponent(token)}`;
export const checkinUrl = (token) => new URL(`checkin.html?c=${encodeURIComponent(token)}`, location.href).href;
