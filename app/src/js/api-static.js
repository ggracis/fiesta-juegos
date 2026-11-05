// Demo backend for GitHub Pages: roster from a generated JSON, state in this browser's localStorage only.
import roster from '../data/demo-roster.json';
import { GAMES } from '../shared/games.js';
import { searchRoster, checkPin } from './demo-core.js';

const mem = {};
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return mem[k] ?? d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { mem[k] = v; } };
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });

export async function search(q) {
  return searchRoster(roster, new Set(read('fiesta.demo.registered', [])), q);
}

export async function register(guestId) {
  const g = roster.find((x) => x.id === guestId);
  if (!g) throw fail('unknown_guest');
  const done = read('fiesta.demo.registered', []);
  if (done.includes(guestId)) throw fail('already_registered', { message: 'Este nombre ya está inscrito. Si eres tú, avisa a la organización.' });
  write('fiesta.demo.registered', [...done, guestId]);
  return { ticketToken: g.ticketToken };
}

export async function ticket(token) {
  const g = roster.find((x) => x.ticketToken === token);
  return g ? { name: g.name, pin: g.pin, checkinToken: g.checkinToken } : null;
}

// ponytail: any roster PIN logs in (panel and phone are different browsers, so registration is not shared).
export async function login(pin, screenId) {
  const fails = read('fiesta.demo.fails', {});
  const r = checkPin(roster, fails, pin, screenId);
  write('fiesta.demo.fails', fails);
  if (r.error) throw fail(r.error, r);
  return { name: r.guest.name, session: 'demo-' + r.guest.id };
}

export async function startAttempt(session, _game) {
  if (!roster.some((g) => 'demo-' + g.id === session)) throw fail('bad_session');
  const a = { attemptId: crypto.randomUUID(), seed: 1 + Math.floor(Math.random() * 2 ** 30), serverStart: Date.now() };
  write('fiesta.demo.attempts', [...read('fiesta.demo.attempts', []), { id: a.attemptId, session, seed: a.seed }]);
  return a;
}

export async function finishAttempt(id, score, durationMs) {
  write('fiesta.demo.attempts', read('fiesta.demo.attempts', []).map((a) => (a.id === id ? { ...a, score, durationMs } : a)));
  return { score, replay: false, prizeWon: false };
}

export async function live() {
  const games = GAMES.filter((g) => g.ready).map((g) => ({ id: g.id, name: g.name, params: g.defaults.params, attemptsLeft: 99 }));
  return { paused: false, transition: { on: false, text: '' }, games, raffle: null };
}

export async function checkinInfo(token) {
  const g = roster.find((x) => x.checkinToken === token);
  return g ? { name: g.name } : null;
}

const unavailable = async () => { throw fail('demo_unavailable'); };
export const checkinAction = unavailable;
export const adminLogin = unavailable;
export const adminLogout = unavailable;
export const adminMe = unavailable;
export const adminState = unavailable;
export const adminSettings = unavailable;
export const adminGame = unavailable;
export const adminGuests = unavailable;
export const adminImportGuests = unavailable;
export const adminGuest = unavailable;
export const adminCheckinGuest = unavailable;
export const adminRanking = unavailable;
export const adminRaffle = unavailable;
export const adminHideRaffle = unavailable;
