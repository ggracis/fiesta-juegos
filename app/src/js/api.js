// One API, two backends chosen at build time (VITE_DATA_MODE = server | static).
// Every call throws Error with .code ('rate_limited', 'already_registered', 'wrong_pin', 'locked', 'network', ...).
export const isDemo = import.meta.env.VITE_DATA_MODE === 'static';

let impl;
const backend = () => (impl ??= isDemo ? import('./api-static.js') : import('./api-server.js'));
const call = (name) => async (...a) => (await backend())[name](...a);

export const search = call('search');
export const register = call('register');
export const ticket = call('ticket');
export const login = call('login');
export const startAttempt = call('startAttempt');
export const finishAttempt = call('finishAttempt');

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
