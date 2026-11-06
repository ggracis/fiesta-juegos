import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';
import { buildApp } from '../server/index.ts';
import { GAMES } from '../src/shared/games.js';

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
  for (const c of ['checked_in_at', 'prize_won_at', 'prize_delivered_at']) assert.ok(cols.includes(c), c);
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
  assert.equal(replay.json().prizeWon, false);
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
  const distinto = (l) => l.games.find((x) => x.id === 'distinto');
  assert.equal(distinto(live).attemptsLeft, 1);
  await start(app, g.session);
  live = (await app.inject(`/api/live?session=${g.session}`)).json();
  assert.equal(distinto(live).attemptsLeft, 0);

  app.db.prepare("UPDATE setting SET value = 'true' WHERE key = 'paused'").run();
  assert.equal((await app.inject('/api/live')).json().paused, true);
  app.db.prepare('UPDATE game_config SET enabled = 0').run();
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
  assert.deepEqual(st.settings, { paused: false, transition: false, transitionText: '', prizeStock: 0, raffleShowSeconds: 15 });
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

  const found = (await app.inject({ url: '/api/admin/guests?q=nuevo', headers: h })).json();
  assert.deepEqual(found.map((x) => x.name), ['Nuevo Uno', 'Nuevo, Dos']);
  assert.equal(found[0].registered, false);
  assert.equal((await app.inject({ url: '/api/admin/guests', headers: h })).json().length, before + 2);

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
  assert.equal(lines[0], 'name,game,score,duration_ms,started_at,finished_at');
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
