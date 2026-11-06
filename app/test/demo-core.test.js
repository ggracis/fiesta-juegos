import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupRoster, registerRoster, checkPin, MAX_FAILS, LOCK_MS } from '../src/js/demo-core.js';

const roster = JSON.parse(readFileSync(new URL('../src/data/demo-roster.json', import.meta.url), 'utf8'));

test('static lookup: found / not found plus the mode, nothing else', () => {
  const mode = 'name_dni_email';
  assert.deepEqual(lookupRoster(roster, 'ANA lucia'), { found: true, mode });
  assert.deepEqual(lookupRoster(roster, 'lucia'), { found: false, mode }); // one token
  assert.deepEqual(lookupRoster(roster, 'nadie aqui'), { found: false, mode });
  assert.equal(lookupRoster(roster, 'ana lucia', 'name_only').mode, 'name_only');
});

test('static register keeps the cleaned dietary text', () => {
  const g = roster[0], ok = { name: 'ana fernandez', dni: g.dni, email: g.email };
  assert.equal(registerRoster(roster, { ...ok, dietary: '  sin   gluten ' }).dietary, 'sin gluten');
  assert.equal(registerRoster(roster, { ...ok, dietary: '  ' }).dietary, null);
  assert.equal(registerRoster(roster, { ...ok, dietary: 'x'.repeat(300) }).dietary.length, 200);
  assert.equal(registerRoster(roster, { ...ok, dni: '1', dietary: 'vegano' }).request.dietary, 'vegano'); // pending keeps it too
  assert.equal(registerRoster(roster, { name: 'ana fernandez', dietary: 'vegano' }, 'name_only').status, 'registered'); // no dni/email
});

test('static register: match -> ticket (repeatable); mismatch -> pending request', () => {
  const g = roster[0], ok = { name: 'ana fernandez', dni: g.dni, email: g.email.toUpperCase() };
  const r = registerRoster(roster, ok);
  assert.deepEqual([r.status, r.ticketToken], ['registered', g.ticketToken]);
  assert.equal(registerRoster(roster, ok).ticketToken, g.ticketToken);
  const bad = registerRoster(roster, { ...ok, dni: '1.234.567' });
  assert.equal(bad.status, 'pending');
  assert.equal(bad.ticketToken, undefined);
  assert.deepEqual([bad.request.dni, bad.request.candidates], ['1234567', [g.id]]);
  assert.equal(registerRoster(roster, { name: 'nadie aqui', dni: g.dni, email: g.email }).request.candidates.length, 0);
  assert.equal(registerRoster(roster, { name: 'ana fernandez', dni: '1', email: 'x' }, 'name_only').status, 'registered');
});

test('demo roster has unique fictitious DNIs and example.com emails', () => {
  assert.equal(new Set(roster.map((g) => g.dni)).size, roster.length);
  assert.ok(roster.every((g) => /^\d{7,8}$/.test(g.dni) && g.email.endsWith('@example.com')));
});

test('static roster: unique PINs and tokens', () => {
  for (const k of ['pin', 'ticketToken', 'checkinToken']) assert.equal(new Set(roster.map((g) => g[k])).size, roster.length);
  assert.ok(roster.every((g) => /^\d{6}$/.test(g.pin)));
});

test('static login: 5 failures lock only that screen for 30 s', () => {
  const fails = {}, pin = roster[0].pin, t0 = 1_000_000;
  assert.ok(checkPin(roster, fails, pin, 'A', t0).guest);
  let r;
  for (let i = 1; i <= MAX_FAILS; i++) r = checkPin(roster, fails, 'abcdef', 'A', t0);
  assert.equal(r.locked, true);
  assert.equal(checkPin(roster, fails, pin, 'A', t0 + 1000).error, 'locked');
  assert.ok(checkPin(roster, fails, pin, 'B', t0 + 1000).guest); // other screen unaffected
  assert.ok(checkPin(roster, fails, pin, 'A', t0 + LOCK_MS + 1).guest); // lock expires
});
