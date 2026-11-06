import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundScore, totalScore, clampScore } from '../src/shared/scoring.js';
import { generatePin } from '../server/lib.ts';
import { buildApp } from '../server/index.ts';

test('round scoring', () => {
  assert.equal(roundScore({ found: true, ms: 800 }), 10);
  assert.equal(roundScore({ found: true, ms: 1499 }), 10);
  assert.equal(roundScore({ found: true, ms: 1500 }), 9);
  assert.equal(roundScore({ found: true, ms: 2000 }), 8);
  assert.equal(roundScore({ found: true, ms: 7900 }), 2);
  assert.equal(roundScore({ found: false, ms: 8000 }), 0);
  assert.equal(roundScore({ found: true, ms: 1000, wrong: 2 }), 6);
  assert.equal(roundScore({ found: true, ms: 1000, wrong: 9 }), 0);
  assert.equal(totalScore(Array(10).fill({ found: true, ms: 500 })), 100);
  assert.equal(clampScore(250), 100);
  assert.equal(clampScore(-5), 0);
});

test('PIN format and uniqueness', () => {
  const used = new Set();
  for (let i = 0; i < 2000; i++) {
    const pin = generatePin((p) => used.has(p));
    assert.match(pin, /^\d{6}$/);
    assert.ok(!used.has(pin));
    used.add(pin);
  }
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
const reg = (app, name, dni, email) => post(app, '/api/register', { name, dni, email });
const ANA = ['ana lucia fernandez', '20.000.000', 'ana.lucia.fernandez@example.com'];

test('lookup: found / not found, no roster data leaked', async () => {
  const app = buildApp(':memory:');
  assert.deepEqual((await post(app, '/api/lookup', { name: 'ANA fernandez' })).json(), { found: true });
  assert.deepEqual((await post(app, '/api/lookup', { name: 'ana' })).json(), { found: false }); // one token
  assert.deepEqual((await post(app, '/api/lookup', { name: 'zzz yyy' })).json(), { found: false });
  assert.equal((await post(app, '/api/lookup', { name: 'a' })).statusCode, 400);
  assert.equal((await app.inject('/api/guests/search?q=demo')).statusCode, 404); // old endpoint is gone
  await app.close();
});

test('register: match -> ticket; same data again -> same ticket; mismatch -> pending row', async () => {
  const app = buildApp(':memory:');
  const r1 = (await reg(app, ...ANA)).json();
  assert.equal(r1.status, 'registered');
  assert.match((await app.inject('/api/ticket/' + r1.ticketToken)).json().pin, /^\d{6}$/);
  const r2 = (await reg(app, 'Fernández Ana Lucía', '20000000', '  ANA.LUCIA.FERNANDEZ@example.com ')).json();
  assert.deepEqual(r2, r1); // lost-ticket recovery
  const bad = (await reg(app, ANA[0], '20.000.001', ANA[2])).json();
  assert.deepEqual(bad, { status: 'pending' });
  assert.equal((await reg(app, 'zzz yyy', '12.345.678', 'a@b.co')).json().status, 'pending');
  assert.equal((await reg(app, ANA[0], '123', ANA[2])).statusCode, 400);
  assert.equal((await reg(app, ANA[0], ANA[1], 'nope')).statusCode, 400);
  await app.close();
});

test('register: pending request is persisted with candidate ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiesta-'));
  const csv = join(dir, 'g.csv');
  writeFileSync(csv, 'name,dni,email\nAna Gómez,1111111,a@x.com\nAna María Gómez,2222222,b@x.com\n');
  const file = join(dir, 'f.db');
  const app = buildApp(file, csv);
  assert.equal((await reg(app, 'ana gomez', '1.111.111', 'b@x.com')).json().status, 'pending'); // DNI of one, email of the other
  assert.equal((await reg(app, 'ana gomez', '2.222.222', 'B@x.com')).json().status, 'registered'); // namesakes resolved by DNI+email
  await app.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT * FROM verification_request').get();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_request').get().n, 1);
  assert.deepEqual([row.name, row.dni, row.email, row.candidates], ['ana gomez', '1111111', 'b@x.com', '[1,2]']);
  db.close();
});

test('register endpoint is rate limited', async () => {
  const app = buildApp(':memory:');
  let last;
  for (let i = 0; i < 11; i++) last = await reg(app, 'zzz yyy', '12.345.678', 'a@b.co');
  assert.equal(last.statusCode, 429);
  await app.close();
});

test('login lockout is keyed by screen id, not IP', async () => {
  const app = buildApp(':memory:');
  const reg = await app.inject({ method: 'POST', url: '/api/register', payload: { name: ANA[0], dni: ANA[1], email: ANA[2] } });
  const { ticketToken } = reg.json();
  const ticket = (await app.inject('/api/ticket/' + ticketToken)).json();
  assert.match(ticket.checkinToken, /./);
  const login = (pin, screenId) => app.inject({ method: 'POST', url: '/api/login', payload: { pin, screenId } });
  assert.equal((await login(ticket.pin, 'screen-aaaa')).statusCode, 200);
  assert.equal((await login('000000', 'screen-aaaa')).statusCode, 401); // 000000 is never a real PIN here
  for (let i = 0; i < 4; i++) await login('000000', 'screen-aaaa');
  assert.equal((await login(ticket.pin, 'screen-aaaa')).statusCode, 429); // screen A locked
  assert.equal((await login(ticket.pin, 'screen-bbbb')).statusCode, 200); // screen B, same IP, unaffected
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { pin: ticket.pin } })).statusCode, 400); // screenId required
  await app.close();
});
