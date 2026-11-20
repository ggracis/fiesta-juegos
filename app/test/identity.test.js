import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameTokens, matchesName, validEmail, verify, guestRow } from '../src/shared/identity.js';

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
  const rows = [{ id: 1, name: 'Ana Gómez', email: 'a@x.com' }, { id: 2, name: 'Ana María Gómez', email: 'b@x.com' }, { id: 3, name: 'Ana Pérez', email: 'c@x.com' }];
  const hits = rows.filter((g) => matchesName(g.name, 'ana gomez'));
  assert.deepEqual(hits.map((g) => g.id), [1, 2]);
  assert.equal(verify(hits, { email: ' B@X.com ' }).guest.id, 2);
  assert.deepEqual(verify(hits, { email: 'zzz@x.com' }), { pending: [1, 2] }); // wrong email: staff decide
  assert.deepEqual(verify(hits, { email: '' }), { pending: [1, 2] }); // an empty email never matches
});

test('validation modes', () => {
  const a = { id: 1, email: 'a' }, b = { id: 2, email: 'b' };
  assert.equal(verify([a], { email: 'x' }, 'name_only').guest, a);
  assert.deepEqual(verify([a, b], { email: 'a' }, 'name_only'), { pending: [1, 2] });
  assert.deepEqual(verify([], { email: 'a' }), { pending: [] }); // unknown name: pending with no candidates
});

test('email validation and roster rows', () => {
  assert.ok(validEmail('a@b.co') && !validEmail('a@b') && !validEmail('a b@c.com'));
  for (const ok of ['Lucas.Albarracin@efergia.com', ' x+tag@sub.h-partners.com.ar ', 'a_b-c%d@x.io']) assert.ok(validEmail(ok), ok);
  for (const bad of ['ĺucas.albarracin@efergia.com', 'josé@x.com', 'nuñez@x.com', 'a@exámple.com', 'a..b@x.com', '.a@x.com', 'a.@x.com',
    'a@x..com', 'a@-x.com', 'a@x.c', 'a@@x.com', 'a"b@x.com', 'a,b@x.com', 'a@x.com.']) assert.ok(!validEmail(bad), bad);
  assert.equal(guestRow(['Ana', 'josé@x.com']).email, ''); // imported malformed address is dropped
});

test('guestRow: name in A, email is the first other cell with an @ (2 or legacy 3 columns)', () => {
  assert.deepEqual(guestRow([' Ana   Gómez ', 'ANA@x.com']), { name: 'Ana Gómez', email: 'ana@x.com' });
  assert.deepEqual(guestRow(['Ana Gómez', '20123456', 'a@x.com']), { name: 'Ana Gómez', email: 'a@x.com' });
  assert.deepEqual(guestRow(['Ana Gómez']), { name: 'Ana Gómez', email: '' });
});
