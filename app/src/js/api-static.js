// Demo backend for GitHub Pages: roster from a generated JSON, state in this browser's localStorage only.
import roster from '../data/demo-roster.json';
import { lookupRoster, registerRoster, checkPin } from './demo-core.js';

const mem = {};
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return mem[k] ?? d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { mem[k] = v; } };
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });

export async function lookup(name) {
  return lookupRoster(roster, name);
}

// Pending verification requests only live in this browser's localStorage.
export async function register(name, dni, email) {
  const r = registerRoster(roster, { name, dni, email });
  if (r.request) write('fiesta.demo.pending', [...read('fiesta.demo.pending', []), r.request]);
  return { status: r.status, ticketToken: r.ticketToken };
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

export async function startAttempt(session) {
  if (!roster.some((g) => 'demo-' + g.id === session)) throw fail('bad_session');
  const a = { attemptId: crypto.randomUUID(), seed: 1 + Math.floor(Math.random() * 2 ** 30), serverStart: Date.now() };
  write('fiesta.demo.attempts', [...read('fiesta.demo.attempts', []), { id: a.attemptId, session, seed: a.seed }]);
  return a;
}

export async function finishAttempt(id, score, durationMs) {
  write('fiesta.demo.attempts', read('fiesta.demo.attempts', []).map((a) => (a.id === id ? { ...a, score, durationMs } : a)));
  return { score, replay: false };
}
