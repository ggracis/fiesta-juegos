import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameTokens, matchesName, formatDni, dniDigits, validDni, validEmail, verify } from '../src/shared/identity.js';

const N = 'Ana Lucía Fernández Gómez';

test('name normalization: case, accents, punctuation, whitespace', () => {
  assert.deepEqual(nameTokens('  ÁNA   Lucía,  O\'Brien-Gómez. '), ['ana', 'lucia', 'o', 'brien', 'gomez']);
});

test('name matching: full name, accent/case-insensitive, token subsets', () => {
  assert.ok(matchesName(N, 'ana lucia fernandez gomez'));
  assert.ok(matchesName(N, 'ANA LUCÍA FERNÁNDEZ'));
  assert.ok(matchesName(N, 'ana fernandez'));
  assert.ok(matchesName(N, 'Fernández, Ana'));
  assert.ok(matchesName(N, '  gomez   ana  '));
});

test('name matching: too few tokens, unknown tokens, repeated token', () => {
  assert.ok(!matchesName(N, 'ana'));
  assert.ok(!matchesName(N, 'ana ana')); // distinct tokens only
  assert.ok(!matchesName(N, 'ana perez'));
  assert.ok(!matchesName(N, 'ana lu')); // whole tokens, not prefixes
  assert.ok(!matchesName(N, ''));
});

test('namesakes: every matching row is a candidate', () => {
  const rows = [{ id: 1, name: 'Ana Gómez', dni: '1111111', email: 'a@x.com' }, { id: 2, name: 'Ana María Gómez', dni: '2222222', email: 'b@x.com' }, { id: 3, name: 'Ana Pérez', dni: '3333333', email: 'c@x.com' }];
  const hits = rows.filter((g) => matchesName(g.name, 'ana gomez'));
  assert.deepEqual(hits.map((g) => g.id), [1, 2]);
  assert.equal(verify(hits, { dni: '2.222.222', email: ' B@X.com ' }).guest.id, 2);
  assert.deepEqual(verify(hits, { dni: '9.999.999', email: 'b@x.com' }), { pending: [1, 2] });
  assert.deepEqual(verify(hits, { dni: '1.111.111', email: 'b@x.com' }), { pending: [1, 2] }); // DNI and email must belong to the same row
});

test('validation modes', () => {
  const a = { id: 1, dni: '1', email: 'a' }, b = { id: 2, dni: '2', email: 'b' };
  assert.equal(verify([a], { dni: 'x', email: 'x' }, 'name_only').guest, a);
  assert.deepEqual(verify([a, b], { dni: '1', email: 'a' }, 'name_only'), { pending: [1, 2] });
  assert.deepEqual(verify([], { dni: '1', email: 'a' }), { pending: [] });
});

test('DNI formatting and validation', () => {
  assert.equal(formatDni('12345678'), '12.345.678');
  assert.equal(formatDni('1234567'), '1.234.567');
  assert.equal(formatDni('123'), '123');
  assert.equal(formatDni('1234'), '1.234');
  assert.equal(formatDni('12.345.6789012'), '12.345.678'); // max 8 digits
  assert.equal(formatDni('a1b2'), '12');
  assert.equal(dniDigits('12.345.678'), '12345678');
  assert.ok(validDni('1.234.567') && validDni('12.345.678'));
  assert.ok(!validDni('123456') && !validDni(''));
  assert.ok(validEmail('a@b.co') && !validEmail('a@b') && !validEmail('a b@c.com'));
});
