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

test('search needs >= 3 chars and returns <= 5', async () => {
  const app = buildApp(':memory:');
  assert.equal((await app.inject('/api/guests/search?q=an')).statusCode, 400);
  const res = await app.inject('/api/guests/search?q=demo');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().length, 5);
  assert.ok((await app.inject('/api/guests/search?q=lucia')).json().length >= 1);
  await app.close();
});

test('login lockout is keyed by screen id, not IP', async () => {
  const app = buildApp(':memory:');
  const reg = await app.inject({ method: 'POST', url: '/api/register', payload: { guestId: 1 } });
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
