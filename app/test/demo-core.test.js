import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchRoster, checkPin, MAX_FAILS, LOCK_MS } from '../src/js/demo-core.js';

const roster = JSON.parse(readFileSync(new URL('../src/data/demo-roster.json', import.meta.url), 'utf8'));

test('static search: >= 3 chars, accent-insensitive, max 5, flags registered', () => {
  assert.deepEqual(searchRoster(roster, new Set(), 'an'), []);
  assert.equal(searchRoster(roster, new Set(), 'demo').length, 5);
  const hit = searchRoster(roster, new Set([1]), 'lucia');
  assert.ok(hit.length >= 1);
  assert.equal(hit.find((g) => g.id === 1).registered, true);
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
