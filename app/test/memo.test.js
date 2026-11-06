import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoScore } from '../src/shared/scoring.js';
import { gameById } from '../src/shared/games.js';
import { buildApp } from '../server/index.ts';

const P = gameById('memo').defaults.params;

test('memoScore: finish formula, floor and time-out', () => {
  assert.equal(memoScore({ finished: true, ms: 35_000, wrong: 4 }, P), 77); // client example
  assert.equal(memoScore({ finished: true, ms: 35_900, wrong: 4 }, P), 77); // whole seconds
  assert.equal(memoScore({ finished: true, ms: 15_000, wrong: 0 }, P), 100); // inside the free seconds
  assert.equal(memoScore({ finished: true, ms: 85_000, wrong: 10 }, P), 40); // 15 by formula -> floor
  assert.equal(memoScore({ finished: true, ms: 85_000, wrong: 10 }, { ...P, finishFloor: 0 }), 15);
  assert.equal(memoScore({ finished: false, pairs: 7 }, P), 35);
  assert.equal(memoScore({ finished: false, pairs: 0 }, P), 0);
  // finishing never scores less than the best time-out
  for (let s = 0; s <= 90; s += 5) for (let w = 0; w <= 30; w += 3) {
    assert.ok(memoScore({ finished: true, ms: s * 1000, wrong: w }, P) > memoScore({ finished: false, pairs: 7 }, P));
  }
});

const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
async function memoAttempt(app) {
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = 1').get();
  const { ticketToken } = (await post(app, '/api/register', g)).json();
  const { pin } = (await app.inject('/api/ticket/' + ticketToken)).json();
  const { session } = (await post(app, '/api/login', { pin, screenId: 'screen-memo-xxxx' })).json();
  app.db.prepare("UPDATE game_config SET max_attempts = 5 WHERE game = 'memo'").run();
  return async () => (await post(app, '/api/attempts', { session, game: 'memo' })).json().attemptId;
}

test('memo result: under 8 s is rejected', async () => {
  const app = buildApp(':memory:');
  const next = await memoAttempt(app);
  const back = (id, ms) => app.db.prepare('UPDATE attempt SET started_at = started_at - ? WHERE id = ?').run(ms, id);
  const result = (id, durationMs) => post(app, `/api/attempts/${id}/result`, { score: 100, durationMs });

  const a = await next(); back(a, 30_000);
  const fast = await result(a, 7_999);
  assert.equal(fast.statusCode, 400);
  assert.equal(fast.json().error, 'implausible_duration');
  assert.equal((await result(a, 8_000)).json().score, 100);

  const b = await next(); back(b, 5_000); // server clock: only 5 s since the claim
  assert.equal((await result(b, 9_000)).json().error, 'implausible_duration');
  await app.close();
});
