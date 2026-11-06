// Demo backend for GitHub Pages: roster from a generated JSON, state in this browser's localStorage only.
import roster from '../data/demo-roster.json';
import demoContent from '../data/demo-content.json';
import { GAMES, gameById } from '../shared/games.js';
import { buildRounds, publicRounds, mulberry32, ROUND_GAMES, roundsTotal, ROUND_POINTS } from '../shared/rounds.js';
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

export async function startAttempt(session, game) {
  if (!roster.some((g) => 'demo-' + g.id === session)) throw fail('bad_session');
  const a = { attemptId: crypto.randomUUID(), seed: 1 + Math.floor(Math.random() * 2 ** 30), serverStart: Date.now() };
  write('fiesta.demo.attempts', [...read('fiesta.demo.attempts', []), { id: a.attemptId, session, seed: a.seed, game }]);
  return a;
}

const ownAttempt = (id, session) => {
  const a = read('fiesta.demo.attempts', []).find((x) => x.id === id);
  if (!a || a.session !== session) throw fail('bad_session');
  return a;
};
const patchAttempt = (id, patch) => write('fiesta.demo.attempts', read('fiesta.demo.attempts', []).map((a) => (a.id === id ? { ...a, ...patch } : a)));

// Demo only: rounds (with the key) live in localStorage; the real key stays server-side.
export async function rounds(id, session) {
  const a = ownAttempt(id, session);
  if (!ROUND_GAMES.includes(a.game)) throw fail('not_a_round_game');
  let content = a.content;
  if (!content) {
    const p = gameById(a.game).defaults.params;
    try { content = buildRounds(a.game, demoContent[a.game], a.game === 'quiz' ? p.questions : p.images, mulberry32(a.seed)); }
    catch { throw fail('not_enough_content'); }
    patchAttempt(id, { content, answers: [] });
  }
  return { rounds: publicRounds(content) };
}

export async function answer(id, session, index, choice, ms) {
  const a = ownAttempt(id, session);
  if (a.finished) throw fail('finished');
  if (!a.content?.[index]) throw fail('bad_index');
  if (a.answers.some((x) => x.index === index)) throw fail('already_answered');
  const p = gameById(a.game).defaults.params;
  const clamped = Math.max(0, Math.min((p.secondsPerQuestion ?? p.revealSeconds ?? 12) * 1000, Math.round(ms)));
  const correctChoice = a.content[index].answer;
  const correct = choice === correctChoice;
  const points = correct ? (ROUND_POINTS[a.game]?.(true, clamped, p) ?? 0) : 0;
  patchAttempt(id, { answers: [...a.answers, { index, points }] });
  return { correct, correctChoice, points };
}

export async function finishAttempt(id, score, durationMs) {
  const a = read('fiesta.demo.attempts', []).find((x) => x.id === id);
  if (ROUND_GAMES.includes(a?.game)) score = roundsTotal(a.game, a.answers ?? [], a.content?.length ?? 0);
  patchAttempt(id, { score, durationMs, finished: true });
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
export const panelRoster = unavailable;
export const panelSync = unavailable;
export const adminLogin = unavailable;
export const adminLogout = unavailable;
export const adminMe = unavailable;
export const adminState = unavailable;
export const adminSettings = unavailable;
export const adminGame = unavailable;
export const adminContent = unavailable;
export const adminImportContent = unavailable;
export const adminDeleteContent = unavailable;
export const adminGuests = unavailable;
export const adminImportGuests = unavailable;
export const adminGuest = unavailable;
export const adminCheckinGuest = unavailable;
export const adminRanking = unavailable;
export const adminRaffle = unavailable;
export const adminHideRaffle = unavailable;
