import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';
import { buildApp } from '../server/index.ts';
import { GAMES, PARAM_INFO } from '../src/shared/games.js';
import { rafflePhase, scramble, LEAD_MS, SUSPENSE_MS } from '../src/shared/raffle.js';
import { leaderboards, shortName } from '../src/shared/leaderboard.js';

const CSV = join(import.meta.dirname, '..', 'data', 'guests.csv');
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fiesta-')), 'test.db');

// ---- helpers
const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
const put = (app, url, payload, headers) => app.inject({ method: 'PUT', url, payload, headers });
async function guest(app, guestId, screenId = 'screen-' + guestId + '-xxxx') {
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = ?').get(guestId);
  const { ticketToken } = (await post(app, '/api/register', { name: g.name, dni: g.dni, email: g.email })).json();
  const t = (await app.inject('/api/ticket/' + ticketToken)).json();
  const { session } = (await post(app, '/api/login', { pin: t.pin, screenId })).json();
  return { session, checkinToken: t.checkinToken, pin: t.pin, guestId };
}
const start = (app, session, game = 'distinto') => post(app, '/api/attempts', { session, game });
async function finish(app, db, attemptId, score) {
  db.prepare('UPDATE attempt SET started_at = started_at - 10000 WHERE id = ?').run(attemptId);
  return (await post(app, `/api/attempts/${attemptId}/result`, { score, durationMs: 9000 })).json();
}
async function adminApp(opts = {}) {
  const app = buildApp(opts.file ?? ':memory:', undefined, { adminPassword: 'secret' });
  const res = await post(app, '/api/admin/login', { password: 'secret' });
  const cookie = res.headers['set-cookie'].split(';')[0];
  return { app, db: app.db, h: { cookie } };
}

// ---- Task 1
test('openDb twice keeps one game_config row per game', () => {
  const f = tmpFile();
  openDb(f, CSV).close();
  const db = openDb(f, CSV);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_config').get().n, GAMES.length);
  for (const g of GAMES) assert.equal(db.prepare('SELECT enabled FROM game_config WHERE game = ?').get(g.id).enabled, g.ready ? 1 : 0); // seeded enabled = ready
  db.close();
});

test('old-schema DB is migrated in place', () => {
  const f = tmpFile();
  const old = new DatabaseSync(f);
  old.exec(`
    CREATE TABLE guest(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE registration(guest_id INTEGER PRIMARY KEY REFERENCES guest(id), pin TEXT NOT NULL UNIQUE,
      ticket_token TEXT NOT NULL UNIQUE, checkin_token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE attempt(id TEXT PRIMARY KEY, guest_id INTEGER NOT NULL REFERENCES guest(id), seed INTEGER NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, score INTEGER, duration_ms INTEGER);
    INSERT INTO guest(name) VALUES ('Old Guest');
    INSERT INTO attempt(id, guest_id, seed, started_at) VALUES ('a1', 1, 5, 1000);
  `);
  old.close();
  const db = openDb(f, CSV);
  assert.equal(db.prepare("SELECT game FROM attempt WHERE id = 'a1'").get().game, 'distinto');
  const cols = db.prepare('PRAGMA table_info(registration)').all().map((c) => c.name);
  for (const c of ['checked_in_at', 'prize_won_at', 'prize_delivered_at', 'dietary']) assert.ok(cols.includes(c), c);
  assert.ok(db.prepare('PRAGMA table_info(verification_request)').all().some((c) => c.name === 'dietary'));
  db.close();
});

// ---- Task 2
test('session survives restart', async () => {
  const f = tmpFile();
  const a = buildApp(f);
  const g = await guest(a, 1);
  await a.close();
  const b = buildApp(f);
  assert.equal((await start(b, g.session)).statusCode, 200);
  await b.close();
});

test('attempts: validation, max attempts, availability', async () => {
  const app = buildApp(':memory:');
  const g = await guest(app, 1);
  assert.equal((await start(app, 'nope')).statusCode, 401);
  assert.equal((await start(app, g.session, 'nope')).statusCode, 400);
  assert.equal((await start(app, g.session, 'nope')).json().error, 'unknown_game');
  assert.equal((await post(app, '/api/attempts', { session: g.session })).statusCode, 400); // game required
  app.db.prepare("UPDATE game_config SET enabled = 0 WHERE game = 'quiz'").run();
  assert.equal((await start(app, g.session, 'quiz')).json().error, 'game_unavailable'); // disabled
  assert.equal((await start(app, g.session)).statusCode, 200);
  const second = await start(app, g.session);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'max_attempts'); // unfinished attempt counts
  app.db.prepare("UPDATE game_config SET max_attempts = 2 WHERE game = 'distinto'").run();
  assert.equal((await start(app, g.session)).statusCode, 200);
  app.db.prepare("UPDATE game_config SET enabled = 0, max_attempts = 5 WHERE game = 'distinto'").run();
  assert.equal((await start(app, g.session)).json().error, 'game_unavailable');
  app.db.prepare("UPDATE game_config SET enabled = 1 WHERE game = 'distinto'").run();
  app.db.prepare("UPDATE setting SET value = 'true' WHERE key = 'paused'").run();
  assert.equal((await start(app, g.session)).json().error, 'game_unavailable');
  await app.close();
});

test('prize: respects stock, threshold and one per guest', async () => {
  const app = buildApp(':memory:');
  const db = app.db;
  db.prepare("UPDATE setting SET value = '1' WHERE key = 'prizeStock'").run();
  db.prepare("UPDATE game_config SET max_attempts = 3 WHERE game = 'distinto'").run();
  const g1 = await guest(app, 1), g2 = await guest(app, 2);
  const a1 = (await start(app, g1.session)).json();
  assert.equal((await finish(app, db, a1.attemptId, 50)).prizeWon, false);
  const a2 = (await start(app, g1.session)).json();
  assert.equal((await finish(app, db, a2.attemptId, 90)).prizeWon, true);
  const replay = await post(app, `/api/attempts/${a2.attemptId}/result`, { score: 90, durationMs: 9000 });
  assert.equal(replay.json().prizeWon, true); // replay reports the stored outcome: a lost response must not hide the prize
  const a3 = (await start(app, g1.session)).json();
  assert.equal((await finish(app, db, a3.attemptId, 95)).prizeWon, false); // already has one
  const b1 = (await start(app, g2.session)).json();
  assert.equal((await finish(app, db, b1.attemptId, 100)).prizeWon, false); // stock exhausted
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registration WHERE prize_won_at IS NOT NULL').get().n, 1);
  await app.close();
});

// ---- Task 3
test('live: heartbeat, games, paused, attemptsLeft, raffle', async () => {
  const app = buildApp(':memory:');
  const sid = 'screen-live-1';
  app.db.prepare("UPDATE game_config SET enabled = 0 WHERE game <> 'distinto'").run(); // this test is about distinto only
  let live = (await app.inject(`/api/live?screenId=${sid}&game=menu`)).json();
  assert.equal(live.paused, false);
  assert.deepEqual(live.transition, { on: false, text: '' });
  assert.equal(live.raffle, null);
  assert.deepEqual(live.games.map((g) => g.id), ['distinto']);
  assert.equal(live.games[0].attemptsLeft, undefined);
  assert.equal(app.db.prepare('SELECT game FROM screen WHERE id = ?').get(sid).game, 'menu');
  await app.inject(`/api/live?screenId=${sid}&game=distinto`);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM screen').get().n, 1);
  assert.equal(app.db.prepare('SELECT game FROM screen WHERE id = ?').get(sid).game, 'distinto');
  await app.inject('/api/live?screenId=short'); // too short: ignored
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM screen').get().n, 1);

  const g = await guest(app, 1);
  live = (await app.inject(`/api/live?session=${g.session}`)).json();
  assert.equal(live.games[0].attemptsLeft, 1);
  await start(app, g.session);
  live = (await app.inject(`/api/live?session=${g.session}`)).json();
  assert.equal(live.games[0].attemptsLeft, 0);

  app.db.prepare("UPDATE setting SET value = 'true' WHERE key = 'paused'").run();
  assert.equal((await app.inject('/api/live')).json().paused, true);
  app.db.prepare("UPDATE game_config SET enabled = 0 WHERE game = 'distinto'").run();
  assert.deepEqual((await app.inject('/api/live')).json().games, []);
  await app.close();
});

// ---- Task 4
test('admin auth', async () => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  assert.equal((await app.inject('/api/admin/me')).statusCode, 401);
  const bad = await post(app, '/api/admin/login', { password: 'nope' });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, 'wrong_password');
  const ok = await post(app, '/api/admin/login', { password: 'secret' });
  assert.equal(ok.statusCode, 204);
  assert.match(ok.headers['set-cookie'], /HttpOnly/);
  assert.match(ok.headers['set-cookie'], /SameSite=Strict/);
  const h = { cookie: ok.headers['set-cookie'].split(';')[0] };
  assert.deepEqual((await app.inject({ url: '/api/admin/me', headers: h })).json(), { role: 'admin' });
  assert.equal((await post(app, '/api/admin/logout', undefined, h)).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/admin/me', headers: h })).statusCode, 401);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'logout'").get().n, 1);
  await app.close();
});

test('admin login rate limit and disabled', async () => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  for (let i = 0; i < 10; i++) assert.equal((await post(app, '/api/admin/login', { password: 'x' })).statusCode, 401);
  assert.equal((await post(app, '/api/admin/login', { password: 'x' })).statusCode, 429);
  assert.equal((await post(app, '/api/admin/login', { password: 'secret' })).statusCode, 429);
  await app.close();
  const ok = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  for (let i = 0; i < 15; i++) assert.equal((await post(ok, '/api/admin/login', { password: 'secret' })).statusCode, 204);
  await ok.close();
  const off = buildApp(':memory:', undefined, { adminPassword: '' });
  const r = await post(off, '/api/admin/login', { password: 'x' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'admin_disabled');
  await off.close();
});

// ---- Task 5
test('admin settings and games', async () => {
  const { app, h } = await adminApp();
  assert.equal((await app.inject('/api/admin/state')).statusCode, 401);
  const st = (await app.inject({ url: '/api/admin/state', headers: h })).json();
  assert.deepEqual(st.settings, { paused: false, transition: false, transitionText: '', prizeStock: 0, raffleShowSeconds: 15, raffleMode: false });
  assert.equal(st.games.length, GAMES.length);
  assert.deepEqual(st.prizes, { stock: 0, won: 0, delivered: 0, left: 0 });
  assert.deepEqual(st.screens, []);

  const s = await put(app, '/api/admin/settings', { paused: true, prizeStock: 5, transitionText: 'Ya vuelve' }, h);
  assert.equal(s.json().paused, true);
  assert.equal(s.json().prizeStock, 5);
  assert.equal((await app.inject({ url: '/api/admin/state', headers: h })).json().prizes.left, 5);
  assert.equal((await put(app, '/api/admin/settings', { bogus: 1 }, h)).statusCode, 400);
  assert.equal((await put(app, '/api/admin/settings', { prizeStock: -1 }, h)).statusCode, 400);

  const g = await put(app, '/api/admin/games/distinto', { threshold: 80, params: { rounds: 5 } }, h);
  assert.equal(g.statusCode, 200);
  assert.equal(g.json().threshold, 80);
  assert.equal(g.json().params.rounds, 5);
  assert.equal(g.json().params.idleSeconds, 20); // default keys are merged on read
  assert.equal(g.json().maxAttempts, 1);
  const g2 = await put(app, '/api/admin/games/distinto', { enabled: false }, h);
  assert.equal(g2.json().threshold, 80);
  assert.equal(g2.json().enabled, false);
  assert.equal((await put(app, '/api/admin/games/nope', { enabled: true }, h)).statusCode, 404);
  assert.equal((await put(app, '/api/admin/games/distinto', { maxAttempts: 0 }, h)).statusCode, 400);
  assert.ok(app.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n >= 3);
  await app.close();
});

test('admin guests import, list, detail, checkin', async () => {
  const { app, h } = await adminApp();
  const csv = (body) => post(app, '/api/admin/guests/import', body, { ...h, 'content-type': 'text/csv' });
  const before = app.db.prepare('SELECT COUNT(*) AS n FROM guest').get().n;
  const r = await csv('﻿# comment\r\nname,dni,email\r\nNuevo Uno,30.111.222,Uno@X.com\r\n"Nuevo, Dos",30111333,dos@x.com\r\n\r\nAna Lucía Fernández (demo)\r\nNuevo Uno\r\n');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { added: 2, total: before + 2 });
  assert.equal((await post(app, '/api/admin/guests/import', 'x', { 'content-type': 'text/csv' })).statusCode, 401);

  const found = (await app.inject({ url: '/api/admin/guests?q=nuevo', headers: h })).json().guests;
  assert.deepEqual(found.map((x) => x.name), ['Nuevo Uno', 'Nuevo, Dos']);
  assert.equal(found[0].registered, false);
  assert.equal((await app.inject({ url: '/api/admin/guests', headers: h })).json().guests.length, before + 2);

  const id = found[0].id;
  const nr = await post(app, `/api/admin/guests/${id}/checkin`, undefined, h);
  assert.equal(nr.statusCode, 409);
  assert.equal(nr.json().error, 'not_registered');
  assert.equal(app.db.prepare('SELECT email FROM guest WHERE id = ?').get(id).email, 'uno@x.com'); // re-import without email kept it
  assert.equal((await post(app, '/api/register', { name: 'nuevo uno', dni: '30111222', email: 'uno@x.com' })).json().status, 'registered');
  const c = await post(app, `/api/admin/guests/${id}/checkin`, undefined, h);
  assert.equal(c.statusCode, 200);
  assert.ok(c.json().checkedInAt > 0);
  const d = (await app.inject({ url: `/api/admin/guests/${id}`, headers: h })).json();
  assert.equal(d.name, 'Nuevo Uno');
  assert.deepEqual(d.attempts, []);
  assert.equal((await app.inject({ url: '/api/admin/guests/999999', headers: h })).statusCode, 404);
  await app.close();
});

test('ranking and attempts csv', async () => {
  const { app, db, h } = await adminApp();
  db.prepare("UPDATE game_config SET max_attempts = 5 WHERE game = 'distinto'").run();
  db.prepare("UPDATE guest SET name = 'Perez, Ana' WHERE id = 1").run();
  const g1 = await guest(app, 1), g2 = await guest(app, 2);
  const run = async (g, score, ms) => {
    const a = (await start(app, g.session)).json();
    db.prepare('UPDATE attempt SET started_at = started_at - 10000 WHERE id = ?').run(a.attemptId);
    await post(app, `/api/attempts/${a.attemptId}/result`, { score, durationMs: ms });
  };
  await run(g1, 60, 9000);
  await run(g1, 80, 9000);
  await run(g2, 80, 7000);
  const rank = (await app.inject({ url: '/api/admin/ranking/distinto', headers: h })).json();
  assert.equal(rank.length, 2);
  assert.deepEqual(rank.map((r) => [r.score, r.durationMs]), [[80, 7000], [80, 9000]]);
  assert.equal((await app.inject({ url: '/api/admin/ranking/nope', headers: h })).statusCode, 404);
  const csv = await app.inject({ url: '/api/admin/attempts.csv', headers: h });
  assert.match(csv.headers['content-type'], /text\/csv/);
  const lines = csv.body.trim().split('\n');
  assert.equal(lines[0], 'name,game,score,duration_ms,started_at,finished_at,dietary');
  assert.equal(lines.length, 4);
  assert.ok(csv.body.includes('"Perez, Ana",distinto,'));
  await app.close();
});

// ---- Task 6
test('public checkin hides details without staff cookie', async () => {
  const { app, h } = await adminApp();
  const g = await guest(app, 1);
  assert.deepEqual((await app.inject('/api/checkin/' + g.checkinToken)).json(), { name: 'Ana Lucía Fernández (demo)' });
  assert.equal((await app.inject('/api/checkin/zzz')).statusCode, 404);
  const staff = (await app.inject({ url: '/api/checkin/' + g.checkinToken, headers: h })).json();
  assert.equal(staff.checkedInAt, null);
  assert.equal(staff.prizeWonAt, null);
  assert.equal(staff.prizeDeliveredAt, null);
  await app.close();
});

test('staff checkin and deliver', async () => {
  const { app, db, h } = await adminApp();
  const g = await guest(app, 1);
  const url = '/api/admin/checkin/' + g.checkinToken;
  assert.equal((await post(app, url, { action: 'checkin' })).statusCode, 401);
  assert.equal((await post(app, '/api/admin/checkin/zzz', { action: 'checkin' }, h)).statusCode, 404);
  const c = await post(app, url, { action: 'checkin' }, h);
  assert.equal(c.statusCode, 200);
  assert.ok(c.json().checkedInAt > 0);
  assert.equal((await post(app, url, { action: 'checkin' }, h)).json().error, 'already_checked_in');
  assert.equal((await post(app, url, { action: 'deliver' }, h)).json().error, 'no_prize');
  assert.equal((await post(app, url, { action: 'bogus' }, h)).statusCode, 400);
  db.prepare('UPDATE registration SET prize_won_at = 1 WHERE guest_id = 1').run();
  const d = await post(app, url, { action: 'deliver' }, h);
  assert.equal(d.statusCode, 200);
  assert.ok(d.json().prizeDeliveredAt > 0);
  const again = await post(app, url, { action: 'deliver' }, h);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_delivered');
  await app.close();
});

test('raffle draws distinct checked-in guests and hides', async () => {
  const { app, h } = await adminApp();
  assert.equal((await post(app, '/api/admin/raffle', undefined, h)).json().error, 'no_candidates');
  for (const id of [1, 2, 3]) {
    const g = await guest(app, id);
    await post(app, '/api/admin/checkin/' + g.checkinToken, { action: 'checkin' }, h);
  }
  await guest(app, 4); // registered but not checked in
  const names = new Set();
  for (let i = 0; i < 3; i++) {
    const r = await post(app, '/api/admin/raffle', undefined, h);
    assert.equal(r.statusCode, 200);
    names.add(r.json().name);
  }
  assert.equal(names.size, 3);
  assert.equal((await post(app, '/api/admin/raffle', undefined, h)).statusCode, 409);
  const live = (await app.inject('/api/live')).json();
  assert.ok(names.has(live.raffle.name));
  assert.equal(live.raffle.showSeconds, 15);
  assert.equal((await post(app, '/api/admin/raffle/hide', undefined, h)).statusCode, 204);
  assert.equal((await app.inject('/api/live')).json().raffle, null);
  await app.close();
});

test('csv export neutralizes formulas', async () => {
  const { app, db, h } = await adminApp();
  db.prepare("UPDATE guest SET name = '=cmd|x' WHERE id = 1").run();
  const g = await guest(app, 1);
  await start(app, g.session);
  const csv = await app.inject({ url: '/api/admin/attempts.csv', headers: h });
  assert.ok(csv.body.includes("\n'=cmd|x,distinto,"));
  await app.close();
});

test('admin sees dietary in the guest list, detail and attempts csv', async () => {
  const { app, db, h } = await adminApp();
  const g = await guest(app, 1);
  await post(app, '/api/register', { ...db.prepare('SELECT name, dni, email FROM guest WHERE id = 1').get(), dietary: 'vegano, =cmd' });
  await start(app, g.session);
  const list = (await app.inject({ url: '/api/admin/guests', headers: h })).json().guests;
  assert.equal(list.find((x) => x.id === 1).dietary, 'vegano, =cmd');
  assert.equal(list.find((x) => x.id === 2).dietary, null);
  assert.equal((await app.inject({ url: '/api/admin/guests/1', headers: h })).json().dietary, 'vegano, =cmd');
  const csv = (await app.inject({ url: '/api/admin/attempts.csv', headers: h })).body;
  assert.ok(csv.trim().split('\n')[1].endsWith(',"vegano, =cmd"')); // quoted comma; formula only neutralized when it leads
  await app.close();
});

test('malformed cookie is a 401, not a 500', async () => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  assert.equal((await app.inject({ url: '/api/admin/me', headers: { cookie: 'fa=%E0%A4%A' } })).statusCode, 401);
  await app.close();
});

test('screen heartbeat prunes stale rows', async () => {
  const app = buildApp(':memory:');
  app.db.prepare("INSERT INTO screen(id, last_seen, game) VALUES ('old-screen-1', ?, 'menu')").run(Date.now() - 2 * 3600_000);
  await app.inject('/api/live?screenId=screen-fresh-1');
  assert.deepEqual(app.db.prepare('SELECT id FROM screen').all().map((r) => r.id), ['screen-fresh-1']);
  await app.close();
});

test('csv import keeps a header-less first line', async () => {
  const { app, h } = await adminApp();
  const r = await post(app, '/api/admin/guests/import', 'Sin Header Uno\nSin Header Dos\n', { ...h, 'content-type': 'text/csv' });
  assert.equal(r.json().added, 2);
  await app.close();
});

test('round games stay hidden until their bank has content', async () => {
  const app = buildApp(':memory:');
  const ids = async () => (await app.inject('/api/live')).json().games.map((g) => g.id);
  assert.ok(!(await ids()).includes('quiz'));
  app.db.prepare("INSERT INTO quiz_question(question, correct, wrong1, wrong2, wrong3, category) VALUES ('q', 'a', 'b', 'c', 'd', 'demo')").run();
  assert.ok((await ids()).includes('quiz'));
  await app.close();
});

test('verifications: list without PIN, approve once, dietary carries over, reject', async () => {
  const { app, db, h } = await adminApp();
  const g = db.prepare('SELECT id, name, dni FROM guest ORDER BY id LIMIT 2').all();
  // Right name, wrong DNI -> pending request with that guest as candidate.
  const ask = (name, dietary) => post(app, '/api/register', { name, dni: '11111111', email: 'nobody@example.com', dietary });
  assert.equal((await ask(g[0].name, 'celíaco')).json().status, 'pending');
  assert.equal((await ask(g[1].name)).json().status, 'pending');
  assert.equal((await app.inject({ url: '/api/admin/verifications' })).statusCode, 401);

  const list = await app.inject({ url: '/api/admin/verifications?status=pending', headers: h });
  const [v1, v2] = list.json();
  assert.equal(v1.name, g[0].name);
  assert.equal(v1.dietary, 'celíaco');
  assert.deepEqual(v1.candidates.map((c) => [c.id, c.registered]), [[g[0].id, false]]);
  assert.ok(!/pin|ticket/i.test(list.body));
  assert.equal((await app.inject({ url: '/api/admin/state', headers: h })).json().pendingVerifications, 2);

  const approve = (id, guestId) => post(app, `/api/admin/verifications/${id}/approve`, { guestId }, h);
  const a = await approve(v1.id, g[0].id);
  assert.equal(a.statusCode, 200);
  const t = (await app.inject('/api/ticket/' + a.json().ticketToken)).json();
  assert.match(t.pin, /^\d{6}$/);
  assert.equal((await approve(v1.id, g[0].id)).json().ticketToken, a.json().ticketToken); // idempotent
  assert.equal((await approve(v1.id, g[1].id)).statusCode, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registration WHERE guest_id = ?').get(g[0].id).n, 1);
  assert.equal(db.prepare('SELECT dietary FROM registration WHERE guest_id = ?').get(g[0].id).dietary, 'celíaco');
  const row = db.prepare('SELECT status, resolved_guest_id, resolved_at, resolved_by FROM verification_request WHERE id = ?').get(v1.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.resolved_guest_id, g[0].id);
  assert.ok(row.resolved_at);
  assert.equal(row.resolved_by, 'admin');

  assert.equal((await post(app, `/api/admin/verifications/${v2.id}/reject`, undefined, h)).json().status, 'rejected');
  assert.equal((await approve(v2.id, g[1].id)).statusCode, 409);
  assert.equal((await post(app, `/api/admin/verifications/${v1.id}/reject`, undefined, h)).statusCode, 409);
  assert.equal((await post(app, '/api/admin/verifications/999/reject', undefined, h)).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/admin/verifications', headers: h })).json().length, 0);
  assert.equal((await app.inject({ url: '/api/admin/verifications?status=rejected', headers: h })).json()[0].id, v2.id);
  const actions = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'verification_%' ORDER BY id").all().map((r) => r.action);
  assert.deepEqual(actions, ['verification_approve', 'verification_reject']);
});

test('walk-ins: accredit an unconfirmed guest once, add a guest at the door, no PIN in lists', async () => {
  const { app, db, h } = await adminApp();
  const g = db.prepare('SELECT id FROM guest ORDER BY id LIMIT 1').get();
  const w = await post(app, `/api/admin/guests/${g.id}/walkin`, undefined, h);
  assert.equal(w.statusCode, 200);
  assert.equal((await post(app, `/api/admin/guests/${g.id}/walkin`, undefined, h)).json().ticketToken, w.json().ticketToken);
  const reg = db.prepare('SELECT COUNT(*) AS n, MAX(checked_in_at) AS at FROM registration WHERE guest_id = ?').get(g.id);
  assert.equal(reg.n, 1);
  assert.ok(reg.at > 0);
  assert.match((await app.inject('/api/ticket/' + w.json().ticketToken)).json().pin, /^\d{6}$/);
  assert.equal((await post(app, '/api/admin/guests/999999/walkin', undefined, h)).statusCode, 404);
  assert.equal((await post(app, `/api/admin/guests/${g.id}/walkin`)).statusCode, 401);

  const add = await post(app, '/api/admin/guests', { name: '  Invitado   Sorpresa ', dni: '30.999.111', email: 'S@X.com' }, h);
  assert.equal(add.statusCode, 200);
  const row = db.prepare('SELECT name, dni, email, walk_in FROM guest WHERE id = ?').get(add.json().guestId);
  assert.deepEqual({ ...row }, { name: 'Invitado Sorpresa', dni: '30999111', email: 's@x.com', walk_in: 1 });
  assert.ok(db.prepare('SELECT checked_in_at FROM registration WHERE guest_id = ?').get(add.json().guestId).checked_in_at);
  assert.equal((await post(app, '/api/admin/guests', { name: 'Invitado Sorpresa' }, h)).json().error, 'guest_exists');
  assert.equal((await post(app, '/api/admin/guests', { name: 'Solo Nombre' }, h)).statusCode, 200); // dni/email optional

  const list = await app.inject({ url: '/api/admin/guests?q=sorpresa', headers: h });
  assert.deepEqual(list.json().guests.map((x) => [x.walkIn, x.registered, !!x.checkedInAt]), [[true, true, true]]);
  assert.equal(list.json().guests[0].pin, add.json().pin); // the door card shows the PIN the walk-in got
  assert.match(add.json().pin, /^\d{6}$/);
  assert.equal(w.json().pin, (await app.inject({ url: '/api/admin/guests/' + g.id, headers: h })).json().pin);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'walk_in'").get().n, 3);
});

test('raffle mode: live carries mode, clock and the winner without PINs', async () => {
  const { app, h } = await adminApp();
  let live = (await app.inject('/api/live')).json();
  assert.equal(live.raffleMode, false);
  assert.ok(Math.abs(live.serverNow - Date.now()) < 5000);
  assert.equal((await put(app, '/api/admin/settings', { raffleMode: true }, h)).json().raffleMode, true);
  assert.equal((await app.inject('/api/live')).json().raffleMode, true);

  const pins = [];
  for (const id of [1, 2, 3, 4]) {
    const g = await guest(app, id);
    pins.push(g.pin);
    await post(app, '/api/admin/checkin/' + g.checkinToken, { action: 'checkin' }, h);
  }
  const first = (await post(app, '/api/admin/raffle', undefined, h)).json();
  const second = (await post(app, '/api/admin/raffle', undefined, h)).json();
  const res = await app.inject('/api/live');
  live = res.json();
  assert.equal(live.raffle.id, second.id);
  assert.equal(live.raffle.drawnAt, second.drawnAt);
  assert.equal(live.raffle.name, second.name);
  assert.ok(!res.body.includes(first.name)); // only the latest winner; no other guests' names
  for (const p of pins) assert.ok(!res.body.includes(p));
  assert.ok(!/pin|ticket|checkin/i.test(JSON.stringify(live.raffle)));
  const winners = (await app.inject({ url: '/api/admin/raffle', headers: h })).json();
  assert.deepEqual(winners.map((w) => w.name), [first.name, second.name]);
  await app.close();
});

test('raffle timeline: phase from offset and drawnAt, reel lands on the winner', () => {
  const drawnAt = 1_000_000, show = 15_000, offset = 250; // panel clock 250 ms behind the server
  const at = (serverT) => rafflePhase(serverT - offset, offset, drawnAt, show);
  assert.equal(at(drawnAt).phase, 'wait');
  assert.deepEqual(at(drawnAt + LEAD_MS), { phase: 'suspense', ms: 0 });
  assert.deepEqual(at(drawnAt + LEAD_MS + SUSPENSE_MS - 1), { phase: 'suspense', ms: SUSPENSE_MS - 1 });
  assert.deepEqual(at(drawnAt + LEAD_MS + SUSPENSE_MS + 100), { phase: 'reveal', ms: 100 });
  assert.equal(at(drawnAt + LEAD_MS + SUSPENSE_MS + show).phase, 'done');
  // Two panels with different clocks, same server instant -> same frame.
  assert.deepEqual(rafflePhase(5000 - 400, 400, 0, show), rafflePhase(5000 + 900, -900, 0, show));

  const name = 'Ana María Fernández-Paz';
  assert.equal(scramble(SUSPENSE_MS, name, 7), name); // lands exactly on the winner
  const early = scramble(500, name, 7);
  assert.notEqual(early, name);
  assert.equal(early.length, name.length);
  assert.equal(early.replace(/\p{L}/gu, '_'), name.replace(/\p{L}/gu, '_')); // spaces and hyphens kept, only letters scramble
  assert.equal(scramble(500, name, 7), early); // same instant, same seed -> same letters on every panel
  // Letters lock left to right: the instant each letter settles for good never goes backwards along the name.
  const frames = Array.from({ length: SUSPENSE_MS / 70 + 1 }, (_, k) => scramble(k * 70, name, 7));
  const settle = [...name].map((c, i) => { let k = frames.length; while (k > 0 && frames[k - 1][i] === c) k--; return k; });
  assert.ok(settle[0] > 0 && settle.every((k, i) => i === 0 || k >= settle[i - 1] || !/\p{L}/u.test(name[i])));
});

test('leaderboards: best attempt per guest, short names, ties to the earliest', () => {
  assert.equal(shortName('Ana Lucía Fernández (demo)'), 'Ana F.');
  assert.equal(shortName('Cher'), 'Cher');
  const rows = [
    { guest: 1, name: 'Ana Fernández', game: 'memo', score: 80, at: 3 },
    { guest: 1, name: 'Ana Fernández', game: 'quiz', score: 95, at: 4 },
    { guest: 2, name: 'Bruno Díaz', game: 'memo', score: 80, at: 1 },
    { guest: 3, name: 'Carla Ruiz', game: 'quiz', score: 60, at: 2 },
  ];
  const b = leaderboards(rows, ['memo', 'quiz', 'pixel'], 2);
  assert.deepEqual(b.all, [{ name: 'Ana F.', game: 'quiz', score: 95 }, { name: 'Bruno D.', game: 'memo', score: 80 }]);
  assert.deepEqual(b.byGame.memo.map((r) => r.name), ['Bruno D.', 'Ana F.']); // tie: Bruno scored first
  assert.deepEqual(b.byGame.pixel, []);
});

test('live leaderboard: no private data, cached, skips no_prize plays', async () => {
  const { app, db } = await adminApp();
  const g = await guest(app, 1);
  const a = (await start(app, g.session)).json();
  await finish(app, db, a.attemptId, 77);
  const res = await app.inject('/api/live');
  const lb = res.json().leaderboard;
  const full = db.prepare('SELECT name, dni, email FROM guest WHERE id = 1').get();
  assert.equal(lb.all[0].score, 77);
  assert.equal(lb.all[0].name, shortName(full.name));
  assert.deepEqual(lb.byGame.distinto.map((r) => r.score), [77]);
  const body = JSON.stringify(lb);
  for (const secret of [g.pin, g.session, g.checkinToken, full.dni, full.email, full.name]) assert.ok(!body.includes(secret), secret);
  db.prepare('UPDATE attempt SET score = 99, no_prize = 1').run();
  assert.equal((await app.inject('/api/live')).json().leaderboard.all[0].score, 77); // still cached
});

test('every game setting has an admin label, help and bounds that fit its default', async () => {
  for (const g of GAMES) {
    const { params, ...top } = g.defaults;
    for (const [k, v] of Object.entries({ ...top, ...params })) {
      const i = PARAM_INFO[k];
      assert.ok(i?.label && i.help, `${g.id}.${k} has no label`);
      assert.ok(v >= i.min && v <= i.max, `${g.id}.${k} default ${v} outside ${i.min}-${i.max}`);
    }
  }
  const { app, h } = await adminApp();
  const r = await put(app, '/api/admin/games/memo', { params: { timeLimitS: 5 } }, h);
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.json(), { error: 'out_of_range', param: 'timeLimitS' });
  assert.equal((await put(app, '/api/admin/games/memo', { params: { timeLimitS: 60 } }, h)).statusCode, 200);
  await app.close();
});

test('door list: search by name/DNI/email, filters with counts, pending flag', async () => {
  const { app, db, h } = await adminApp();
  const csv = 'name,dni,email\nJosé Núñez Zarzuelo,30.444.555,jose@empresa.com\nJosefina Paz Zarzuelo,28111222,jp@otra.com\n';
  await post(app, '/api/admin/guests/import', csv, { ...h, 'content-type': 'text/csv' });
  const list = async (qs) => (await app.inject({ url: '/api/admin/guests?' + qs, headers: h })).json();
  assert.deepEqual((await list('q=jose nunez')).guests.map((g) => g.name), ['José Núñez Zarzuelo']); // accents and case
  assert.deepEqual((await list('q=' + encodeURIComponent('30.444.5'))).guests.map((g) => g.name), ['José Núñez Zarzuelo']); // DNI with dots
  assert.deepEqual((await list('q=444555')).guests.map((g) => g.dni), ['30444555']);
  assert.deepEqual((await list('q=EMPRESA.COM')).guests.map((g) => g.name), ['José Núñez Zarzuelo']);
  assert.deepEqual((await list('q=EMPRESA.COM')).guests.map((g) => g.email), ['jose@empresa.com']); // the verification search tells homonyms apart by DNI/email

  const jose = db.prepare("SELECT id FROM guest WHERE name = 'José Núñez Zarzuelo'").get().id;
  const paz = db.prepare("SELECT id FROM guest WHERE name = 'Josefina Paz Zarzuelo'").get().id;
  await post(app, `/api/admin/guests/${jose}/walkin`, undefined, h);
  await post(app, '/api/register', { name: 'Josefina Paz Zarzuelo', dni: '99999999', email: 'x@x.com' }); // wrong data -> pending
  const r = await list('q=zarzuelo');
  assert.deepEqual(r.counts, { all: 2, unaccredited: 1, accredited: 1, unconfirmed: 1, walkIn: 0 });
  assert.deepEqual((await list('q=zarzuelo&filter=accredited')).guests.map((g) => g.id), [jose]);
  assert.equal(r.guests.find((g) => g.id === paz).pendingVerification, true);
  const all = await list('');
  assert.equal(all.summary.total, db.prepare('SELECT COUNT(*) AS n FROM guest').get().n);
  assert.equal(all.summary.accredited, 1);
  assert.equal((await app.inject({ url: '/api/admin/guests?filter=nope', headers: h })).statusCode, 400);
});

test('PIN in plain sight for admins only, never in public payloads', async () => {
  const { app, db, h } = await adminApp();
  const g = await guest(app, 1);
  assert.equal((await app.inject('/api/admin/guests')).statusCode, 401);
  const list = (await app.inject({ url: '/api/admin/guests', headers: h })).json().guests;
  const mine = list.find((x) => x.id === 1);
  assert.equal(mine.pin, g.pin);
  assert.equal((await app.inject('/api/ticket/' + mine.ticketToken)).json().pin, g.pin); // "Abrir ticket" link
  assert.equal(list.find((x) => x.id === 2).pin, null); // not registered yet
  assert.equal((await app.inject({ url: '/api/admin/guests/1', headers: h })).json().pin, g.pin);

  // Public surfaces and verification candidates stay PIN-free.
  const a = (await start(app, g.session)).json();
  await finish(app, db, a.attemptId, 80);
  await post(app, '/api/register', { name: db.prepare('SELECT name FROM guest WHERE id = 1').get().name, dni: '99999999', email: 'x@x.com' });
  const live = await app.inject('/api/live?session=' + g.session);
  assert.equal(live.json().leaderboard.all[0].score, 80);
  for (const res of [live, await app.inject('/api/live'), await app.inject('/api/checkin/' + g.checkinToken),
    await app.inject({ url: '/api/admin/verifications', headers: h })]) {
    assert.ok(!res.body.includes(g.pin), res.body.slice(0, 80));
    assert.ok(!/"pin"/.test(res.body), res.body.slice(0, 80));
  }
});
