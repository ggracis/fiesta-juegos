import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/js/retry.js';

const err = (code) => Object.assign(new Error(code), { code });
const delays = [10, 20, 40];

test('withRetry: retries network errors with backoff, then succeeds', async () => {
  let n = 0;
  const r = await withRetry(async () => { if (++n < 3) throw err('network'); return 'ok'; }, { delays, budgetMs: 1000 });
  assert.equal(r, 'ok');
  assert.equal(n, 3);
});

test('withRetry: other errors (409 already_answered) throw at once', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw err('already_answered'); }, { delays }), { code: 'already_answered' });
  assert.equal(n, 1);
});

test('withRetry: gives up after the last delay', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw err('network'); }, { delays, budgetMs: 1000 }), { code: 'network' });
  assert.equal(n, 4);
});

test('withRetry: a hanging call is cut at the total budget', async () => {
  const t0 = Date.now();
  let n = 0;
  await assert.rejects(withRetry(() => { n++; return new Promise(() => {}); }, { delays, budgetMs: 80 }), { code: 'network' });
  const took = Date.now() - t0;
  assert.ok(took >= 70 && took < 300, `took ${took} ms`);
  assert.equal(n, 1); // no time left for a retry
});

test('withRetry: no retry that would start past the budget', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw err('network'); }, { delays: [50, 50, 50], budgetMs: 130 }), { code: 'network' });
  assert.equal(n, 3); // at ~0, ~50 and ~100 ms; a fourth would start at ~150 >= 130
});

test('withRetry: stops retrying once aborted', async () => {
  const ac = new AbortController();
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; ac.abort(); throw err('network'); }, { delays, signal: ac.signal }), { code: 'network' });
  assert.equal(n, 1);
});
