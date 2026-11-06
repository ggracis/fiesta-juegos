import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../server/index.ts';
import { quizPoints } from '../src/shared/scoring.js';
import { ROUND_POINTS } from '../src/shared/rounds.js';
import { gameById } from '../src/shared/games.js';

const root = join(import.meta.dirname, '..');
const DEMO_CSV = readFileSync(join(root, 'data', 'content', 'quiz-demo.csv'), 'utf8');
const DEMO_JSON = JSON.parse(readFileSync(join(root, 'src', 'data', 'demo-content.json'), 'utf8')).quiz;
const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });

test('quizPoints: 6 + speed bonus, clamped, no bonus under 400 ms', () => {
  const p = { secondsPerQuestion: 12 };
  assert.equal(quizPoints(false, 1000, p), 0);
  assert.equal(quizPoints(true, 400, p), 10); // 11.6 s left -> +4
  assert.equal(quizPoints(true, 6000, p), 8); // the client example: ~2 bonus each
  assert.equal(quizPoints(true, 12000, p), 6);
  assert.equal(quizPoints(true, 999999, p), 6);
  assert.equal(quizPoints(true, 399, p), 6); // implausible: no bonus
  assert.equal(quizPoints(true, -50, p), 6);
  assert.equal(quizPoints(true, 'x', undefined), 6);
  assert.equal(quizPoints(true, 3000, { secondsPerQuestion: 6 }), 8); // bonus scales with the limit
  assert.equal(10 * quizPoints(true, 400, p), 100);
  assert.equal(ROUND_POINTS.quiz, quizPoints);
  assert.deepEqual(gameById('quiz').defaults.params, { idleSeconds: 20, idleWarnSeconds: 5, questions: 10, secondsPerQuestion: 12 });
});

test('demo bank: CSV imports cleanly and matches the static demo JSON', async () => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  const cookie = (await post(app, '/api/admin/login', { password: 'secret' })).headers['set-cookie'].split(';')[0];
  const r = (await post(app, '/api/admin/content/quiz/import', DEMO_CSV, { cookie, 'content-type': 'text/csv' })).json();
  assert.deepEqual([r.added, r.errors], [15, []]);
  const rows = app.db.prepare('SELECT question, correct, wrong1, wrong2, wrong3, category FROM quiz_question ORDER BY id').all();
  assert.ok(rows.every((q) => q.category === 'demo'));
  assert.deepEqual(rows.map((q) => ({ question: q.question, correct: q.correct, wrong: [q.wrong1, q.wrong2, q.wrong3] })), DEMO_JSON);
  await app.close();
});

test('quiz attempt: no key in content, 409 on repeat, ms clamp, server score', async () => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  const cookie = (await post(app, '/api/admin/login', { password: 'secret' })).headers['set-cookie'].split(';')[0];
  await post(app, '/api/admin/content/quiz/import', DEMO_CSV, { cookie, 'content-type': 'text/csv' });
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = 1').get();
  const { ticketToken } = (await post(app, '/api/register', g)).json();
  const { pin } = (await app.inject('/api/ticket/' + ticketToken)).json();
  const { session } = (await post(app, '/api/login', { pin, screenId: 'screen-quiz-test' })).json();

  const start = await post(app, '/api/attempts', { session, game: 'quiz' }); // quiz is ready: real flow
  assert.equal(start.statusCode, 200);
  const id = start.json().attemptId;

  const content = await app.inject(`/api/attempts/${id}/rounds?session=${session}`);
  const { rounds } = content.json();
  assert.equal(rounds.length, 10);
  for (const r of rounds) assert.deepEqual(Object.keys(r).sort(), ['options', 'prompt']);
  assert.ok(!/"(answer|correct)"/.test(content.body));
  const key = JSON.parse(app.db.prepare('SELECT content FROM attempt WHERE id = ?').get(id).content).map((r) => r.answer);

  const ans = (index, choice, ms) => post(app, `/api/attempts/${id}/answer`, { session, index, choice, ms });
  const storedMs = (i) => app.db.prepare('SELECT ms FROM answer WHERE attempt_id = ? AND idx = ?').get(id, i).ms;
  assert.equal((await ans(0, key[0], 100)).json().points, 6); // < 400 ms: no bonus
  assert.equal((await ans(1, key[1], 999999)).json().points, 6);
  assert.equal(storedMs(1), 12000);
  assert.equal((await ans(2, key[2], -50)).json().points, 6);
  assert.equal(storedMs(2), 0);
  assert.equal((await ans(3, key[3], 3000)).json().points, 9);
  const wrong = (await ans(4, (key[4] + 1) % 4, 1000)).json();
  assert.deepEqual(wrong, { correct: false, correctChoice: key[4], points: 0 });
  assert.equal((await ans(5, null, 12000)).json().points, 0);

  const again = await ans(0, key[0], 5000);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_answered');

  app.db.prepare('UPDATE attempt SET started_at = ? WHERE id = ?').run(Date.now() - 60000, id); // pass the min-duration check
  const res = await post(app, `/api/attempts/${id}/result`, { score: 100, durationMs: 60000 });
  assert.equal(res.json().score, 27); // 6 + 6 + 6 + 9, not the client's 100
  assert.equal(app.db.prepare('SELECT score FROM attempt WHERE id = ?').get(id).score, 27);
  await app.close();
});
