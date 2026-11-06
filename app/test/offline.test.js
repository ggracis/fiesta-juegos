import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../server/index.ts';
import {
  createQueue, flush, createFlusher, createPinCheck, hashPin, sha256js, startLocalAttempt, attemptsLeft, bumpCount, isDefinitive,
} from '../src/js/offline.js';

// ---- helpers (same style as admin.test.js)
const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
async function guest(app, guestId) {
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = ?').get(guestId);
  const { ticketToken } = (await post(app, '/api/register', { name: g.name, dni: g.dni, email: g.email })).json();
  const t = (await app.inject('/api/ticket/' + ticketToken)).json();
  const { session } = (await post(app, '/api/login', { pin: t.pin, screenId: 'screen-' + guestId + '-xxxx' })).json();
  return { session, pin: t.pin, guestId };
}
async function staffApp(opts = {}) {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret', ...opts });
  const res = await post(app, '/api/admin/login', { password: 'secret' });
  return { app, db: app.db, h: { cookie: res.headers['set-cookie'].split(';')[0] } };
}
const sync = (app, items, h) => post(app, '/api/panel/sync', { items }, h);
const att = (guestId, extra = {}) => ({ kind: 'attempt', attemptId: randomUUID(), guestId, game: 'distinto', seed: 123, startedAt: Date.now() - 20_000, ...extra });
const res = (attemptId, score = 90) => ({ kind: 'result', attemptId, score, durationMs: 9000 });
const stock = (db, n) => db.prepare("UPDATE setting SET value = ? WHERE key = 'prizeStock'").run(String(n));
const prizes = (db) => db.prepare('SELECT COUNT(*) AS n FROM registration WHERE prize_won_at IS NOT NULL').get().n;

// ---- roster
test('roster: staff only, hashes verify, never exposes the pin', async () => {
  const { app, h } = await staffApp();
  const g = await guest(app, 1);
  assert.equal((await app.inject('/api/panel/roster')).statusCode, 401);
  const r = (await app.inject({ url: '/api/panel/roster', headers: h })).json();
  assert.equal(r.guests.length, 1);
  assert.ok(!('pin' in r.guests[0]));
  assert.equal(r.guests[0].h, createHash('sha256').update(r.salt + ':' + g.pin).digest('hex'));
  assert.equal(r.guests[0].h, await hashPin(async (s) => createHash('sha256').update(s).digest(), r.salt, g.pin));
  assert.deepEqual(r.games.map((x) => x.id), ['distinto']);
  assert.equal(r.games[0].offline, true);
});

test('x-panel-token works only when PANEL_TOKEN is set and equal', async () => {
  const { app } = await staffApp({ panelToken: 'tok-123' });
  const get = (token) => app.inject({ url: '/api/panel/roster', headers: token === undefined ? {} : { 'x-panel-token': token } });
  assert.equal((await get('tok-123')).statusCode, 200);
  assert.equal((await get('tok-124')).statusCode, 401);
  assert.equal((await get('')).statusCode, 401);
  assert.equal((await get()).statusCode, 401);
  assert.equal((await sync(app, [], { 'x-panel-token': 'tok-123' })).statusCode, 200);
  const pre = await app.inject({ method: 'OPTIONS', url: '/api/panel/sync' });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], '*');

  const off = await staffApp(); // no token configured: header is ignored, no CORS
  assert.equal((await off.app.inject({ url: '/api/panel/roster', headers: { 'x-panel-token': '' } })).statusCode, 401);
  assert.equal((await off.app.inject({ url: '/api/panel/roster', headers: { 'x-panel-token': 'undefined' } })).statusCode, 401);
  assert.equal((await off.app.inject('/api/live')).headers['access-control-allow-origin'], undefined);
});

// ---- sync
test('sync: offline attempt + result, resend is idempotent (one attempt, one prize, stock once)', async () => {
  const { app, db, h } = await staffApp();
  await guest(app, 1);
  stock(db, 1);
  const a = att(1);
  const items = [a, res(a.attemptId)];
  assert.equal((await sync(app, items, undefined)).statusCode, 401);
  const first = (await sync(app, items, h)).json().results;
  assert.deepEqual(first.map((x) => x.ok), [true, true]);
  assert.equal(first[1].prizeWon, true);
  const again = (await sync(app, items, h)).json().results;
  assert.deepEqual(again.map((x) => x.ok), [true, true]);
  assert.equal(again[1].replay, true);
  assert.equal(again[1].prizeWon, true); // stored outcome
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempt').get().n, 1);
  assert.equal(prizes(db), 1);
  const row = db.prepare('SELECT offline, no_prize, score, finished_at FROM attempt').get();
  assert.deepEqual({ ...row, finished_at: !!row.finished_at }, { offline: 1, no_prize: 0, score: 90, finished_at: true });
});

test('sync: prize respects stock and one per guest', async () => {
  const { app, db, h } = await staffApp();
  for (const id of [1, 2, 3]) await guest(app, id);
  stock(db, 1);
  db.prepare("UPDATE game_config SET max_attempts = 3 WHERE game = 'distinto'").run();
  const [a1, a1b, a2] = [att(1), att(1), att(2)];
  const out = (await sync(app, [a1, res(a1.attemptId, 50), a1b, res(a1b.attemptId, 95), a2, res(a2.attemptId, 100)], h)).json().results;
  assert.deepEqual(out.filter((x) => x.kind === 'result').map((x) => x.prizeWon), [false, true, false]); // guest 2: stock gone
  assert.equal(prizes(db), 1);
  stock(db, 5);
  const a1c = att(1);
  assert.equal((await sync(app, [a1c, res(a1c.attemptId, 100)], h)).json().results[1].prizeWon, false); // guest 1 already has one
  assert.equal(prizes(db), 1);
});

test('sync: attempt beyond maxAttempts is recorded but flagged and never wins', async () => {
  const { app, db, h } = await staffApp();
  const g = await guest(app, 1);
  stock(db, 5);
  await post(app, '/api/attempts', { session: g.session, game: 'distinto' }); // online attempt takes the only slot
  const a = att(1);
  const out = (await sync(app, [a, res(a.attemptId, 100)], h)).json().results;
  assert.equal(out[0].flagged, true);
  assert.equal(out[1].ok, true);
  assert.equal(out[1].prizeWon, false);
  assert.equal(db.prepare('SELECT no_prize, score FROM attempt WHERE id = ?').get(a.attemptId).no_prize, 1);
  assert.equal(db.prepare('SELECT score FROM attempt WHERE id = ?').get(a.attemptId).score, 100); // the play still counts for the ranking
  assert.equal(prizes(db), 0);
});

test('sync: per-item errors do not abort the batch', async () => {
  const { app, h } = await staffApp();
  await guest(app, 1);
  const ok = att(1);
  const out = (await sync(app, [att(99), att(1, { game: 'quiz' }), res(randomUUID()), { ...att(1), seed: 1.5 }, ok], h)).json().results;
  assert.deepEqual(out.map((x) => x.error ?? 'ok'), ['unknown_guest', 'unknown_game', 'unknown_attempt', 'invalid_input', 'ok']);
  assert.equal((await sync(app, [{ kind: 'attempt', attemptId: 'not-a-uuid' }], h)).statusCode, 400);
});

test('result endpoint is idempotent on resend and keeps the prize outcome', async () => {
  const { app, db } = await staffApp();
  const g = await guest(app, 1);
  stock(db, 1);
  const { attemptId } = (await post(app, '/api/attempts', { session: g.session, game: 'distinto' })).json();
  db.prepare('UPDATE attempt SET started_at = started_at - 10000 WHERE id = ?').run(attemptId);
  const body = { score: 90, durationMs: 9000 };
  const first = (await post(app, `/api/attempts/${attemptId}/result`, body)).json();
  const second = await post(app, `/api/attempts/${attemptId}/result`, body);
  assert.equal(second.statusCode, 200);
  assert.deepEqual([first.prizeWon, first.replay, second.json().prizeWon, second.json().replay, second.json().score], [true, false, true, true, 90]);
  assert.equal(prizes(db), 1);
});

// ---- pure client logic
const memStorage = () => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const net = () => Object.assign(new Error('network'), { code: 'network' });
const http = (status) => Object.assign(new Error('http'), { status });

test('queue persists in order and flush removes only on success or a definitive error', async () => {
  const st = memStorage();
  const q = createQueue(st);
  q.push({ kind: 'attempt', attemptId: 'a' }); q.push({ kind: 'result', attemptId: 'a' }); q.push({ kind: 'result', attemptId: 'b' });
  assert.deepEqual(createQueue(st).items().map((i) => i.kind + i.attemptId), ['attempta', 'resulta', 'resultb']);
  const sent = [];
  let fail = net();
  const send = async (it) => { if (fail) throw fail; sent.push(it.kind + it.attemptId); };
  assert.equal(await flush(q, send), false); // network error: nothing removed, order kept
  assert.equal(q.items().length, 3);
  fail = http(503); assert.equal(await flush(q, send), false);
  fail = http(401); assert.equal(await flush(q, send), false); // staff must log in again: keep
  assert.equal(q.items().length, 3);
  fail = null;
  assert.equal(await flush(q, send), true);
  assert.deepEqual(sent, ['attempta', 'resulta', 'resultb']);
  assert.equal(createQueue(st).items().length, 0);

  q.push({ kind: 'result', attemptId: 'x' }); q.push({ kind: 'result', attemptId: 'y' });
  const log = [];
  assert.equal(await flush(q, async (it) => { log.push(it.attemptId); if (it.attemptId === 'x') throw http(404); }), true); // definitive: dropped, next one still sent
  assert.deepEqual(log, ['x', 'y']);
  assert.equal(q.items().length, 0);
  assert.ok(isDefinitive(http(400)) && isDefinitive(http(404)) && !isDefinitive(http(429)) && !isDefinitive(net()));
});

test('flusher retries with capped backoff and resets after success', async () => {
  const q = createQueue(memStorage());
  q.push({ kind: 'result', attemptId: 'a' });
  let down = true;
  const timers = [];
  const f = createFlusher(q, async () => { if (down) throw net(); }, { setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer() {} });
  for (let i = 0; i < 8; i++) await f.kick();
  assert.deepEqual(timers, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  down = false;
  assert.equal(await f.kick(), true);
  assert.equal(f.delay(), 0);
  assert.equal(q.items().length, 0);
});

test('local PIN check validates against the cached roster and locks after 5 fails', async () => {
  const dig = async (s) => createHash('sha256').update(s).digest();
  const roster = { salt: 'abc', guests: [{ id: 7, name: 'Ana', h: await hashPin(dig, 'abc', '123456'), a: {} }] };
  let t = 1000;
  const check = createPinCheck(() => roster, { digest: dig, now: () => t });
  await assert.rejects(createPinCheck(() => null)('123456'), { code: 'no_roster' });
  assert.deepEqual(await check('123456'), { guestId: 7, name: 'Ana' });
  for (let i = 1; i <= 4; i++) await assert.rejects(check('000000'), { code: 'wrong_pin', remaining: 5 - i, locked: false });
  await assert.rejects(check('000000'), { code: 'wrong_pin', remaining: 0, locked: true, retryAfter: 30 });
  await assert.rejects(check('123456'), { code: 'locked' }); // even the right PIN waits
  t += 30_001;
  assert.deepEqual(await check('123456'), { guestId: 7, name: 'Ana' });
});

test('sha256js matches node crypto', async () => {
  for (const s of ['', 'abc', 'salt:123456', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'ñandú:000000']) {
    assert.equal(Buffer.from(sha256js(s)).toString('hex'), createHash('sha256').update(s).digest('hex'), s);
  }
});

test('local attempts: enforce maxAttempts from cached counts + queue', () => {
  const roster = { guests: [{ id: 1, a: {} }, { id: 2, a: { distinto: 1 } }], games: [{ id: 'distinto', maxAttempts: 1, offline: true }, { id: 'quiz', maxAttempts: 1, offline: false }] };
  const q = createQueue(memStorage());
  const go = (guestId, game = 'distinto') => startLocalAttempt({ roster, queue: q, guestId, game, id: () => 'id' + q.items().length, rand: () => 0.5, now: () => 5 });
  assert.deepEqual(go(1), { attemptId: 'id0', seed: 1 + 2 ** 29, offline: true });
  assert.deepEqual(q.items()[0], { kind: 'attempt', attemptId: 'id0', guestId: 1, game: 'distinto', seed: 1 + 2 ** 29, startedAt: 5 });
  assert.throws(() => go(1), { code: 'max_attempts' }); // queued attempt counts
  assert.throws(() => go(2), { code: 'max_attempts' }); // cached server count counts
  assert.throws(() => go(1, 'quiz'), { code: 'game_unavailable' }); // round games can't be played offline
  assert.equal(attemptsLeft(roster, q, 1, 'distinto'), 0);
  q.remove(q.items()[0]); bumpCount(roster, 1, 'distinto'); // flushed: now counted in the roster instead
  assert.equal(attemptsLeft(roster, q, 1, 'distinto'), 0);
});
