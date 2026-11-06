import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { buildApp } from '../server/index.ts';
import { PIXEL_DIR } from '../server/lib.ts';
import { buildRounds, publicRounds, mulberry32, ROUND_POINTS } from '../src/shared/rounds.js';

const CSV = join(import.meta.dirname, '..', 'data', 'guests.csv');
const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
async function guest(app, guestId) {
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = ?').get(guestId);
  const { ticketToken } = (await post(app, '/api/register', { name: g.name, dni: g.dni, email: g.email })).json();
  const t = (await app.inject('/api/ticket/' + ticketToken)).json();
  return (await post(app, '/api/login', { pin: t.pin, screenId: 'screen-' + guestId + '-xxxx' })).json().session;
}
async function adminApp() {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  const res = await post(app, '/api/admin/login', { password: 'secret' });
  return { app, h: { cookie: res.headers['set-cookie'].split(';')[0] } };
}
const csv = (app, h, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { ...h, 'content-type': 'text/csv' } });
const seedQuiz = (db, n = 12) => {
  const ins = db.prepare('INSERT INTO quiz_question(question, correct, wrong1, wrong2, wrong3) VALUES (?,?,?,?,?)');
  for (let i = 0; i < n; i++) ins.run(`Q${i}`, `ok${i}`, `a${i}`, `b${i}`, `c${i}`);
};
// round games are not "ready", so attempts are inserted directly
const attempt = (db, session, game = 'quiz', seed = 42) => {
  const gid = Number(db.prepare('SELECT ref FROM session WHERE token = ?').get(session).ref);
  const id = 'att-' + Math.random();
  db.prepare('INSERT INTO attempt(id, guest_id, game, seed, started_at) VALUES (?,?,?,?,?)').run(id, gid, game, seed, Date.now() - 10000);
  return id;
};

const quizBank = Array.from({ length: 12 }, (_, i) => ({ question: `Q${i}`, correct: `ok${i}`, wrong: [`a${i}`, `b${i}`, `c${i}`] }));
const G1 = ['a', 'b', 'c', 'd', 'e'], G2 = ['x', 'y', 'z'];
const pixelBank = [
  ...G1.map((x) => ({ file: `${x}.jpg`, label: `L-${x}`, group: 'g1' })),
  ...G2.map((x) => ({ file: `${x}.jpg`, label: `L-${x}`, group: 'g2' })),
];

test('buildRounds: quiz and pixel shape', () => {
  const q = buildRounds('quiz', quizBank, 5, mulberry32(1));
  assert.equal(q.length, 5);
  assert.equal(new Set(q.map((r) => r.prompt)).size, 5);
  for (const r of q) {
    assert.equal(new Set(r.options).size, 4);
    assert.ok(r.options[r.answer].startsWith('ok'));
  }
  assert.equal(buildRounds('quiz', quizBank, 99, mulberry32(1)).length, 12);
  const p = buildRounds('pixel', pixelBank, 8, mulberry32(2));
  assert.equal(p.length, 8);
  assert.equal(new Set(p.map((r) => r.image)).size, 8);
  for (const r of p) {
    assert.equal(new Set(r.options).size, 4);
    assert.equal(r.options[r.answer], pixelBank.find((b) => b.file === r.image).label);
  }
  assert.ok(!('answer' in publicRounds(p)[0]));
});

test('buildRounds: pixel prefers the same group, falls back to others', () => {
  const rounds = buildRounds('pixel', pixelBank, 8, mulberry32(3));
  const x = rounds.find((r) => r.image === 'x.jpg'); // g2 has only 2 siblings: both used, 1 fallback
  assert.equal(x.options.filter((o) => G2.some((k) => o === 'L-' + k)).length, 3);
  const a = rounds.find((r) => r.image === 'a.jpg'); // g1 has 4 siblings: no fallback
  assert.ok(a.options.every((o) => G1.some((k) => o === 'L-' + k)));
});

test('buildRounds: not_enough_content', () => {
  assert.throws(() => buildRounds('pixel', pixelBank.slice(0, 3), 8, mulberry32(1)), /not_enough_content/);
  assert.throws(() => buildRounds('quiz', [], 8, mulberry32(1)), /not_enough_content/);
});

test('rounds endpoint: no key leaked, stable, owner only, pixel urls', async () => {
  const app = buildApp(':memory:');
  seedQuiz(app.db);
  const s1 = await guest(app, 1), s2 = await guest(app, 2);
  const id = attempt(app.db, s1);
  const a = await app.inject(`/api/attempts/${id}/rounds?session=${s1}`);
  assert.equal(a.statusCode, 200);
  assert.ok(!a.body.includes('answer'));
  assert.equal(a.json().rounds.length, 10);
  assert.equal((await app.inject(`/api/attempts/${id}/rounds?session=${s1}`)).body, a.body);
  assert.equal((await app.inject(`/api/attempts/${id}/rounds?session=${s2}`)).statusCode, 401);
  assert.equal((await app.inject(`/api/attempts/nope/rounds?session=${s1}`)).statusCode, 404);
  assert.equal((await app.inject(`/api/attempts/${attempt(app.db, s1, 'distinto')}/rounds?session=${s1}`)).statusCode, 400);
  const px = attempt(app.db, s1, 'pixel');
  assert.equal((await app.inject(`/api/attempts/${px}/rounds?session=${s1}`)).json().error, 'not_enough_content');
  const ins = app.db.prepare('INSERT INTO pixel_image(file, label, grp) VALUES (?,?,?)');
  for (const x of 'abcd') ins.run(x + '.jpg', 'L' + x, 'g');
  const p = (await app.inject(`/api/attempts/${px}/rounds?session=${s1}`)).json().rounds;
  assert.ok(p[0].image.startsWith('content/pixel/'));
  await app.close();
});

test('answer: repeat, ms clamp, errors; result ignores client score', async () => {
  const app = buildApp(':memory:');
  seedQuiz(app.db);
  const s = await guest(app, 1);
  const id = attempt(app.db, s);
  const ans = (index, choice, ms = 1000, session = s) => post(app, `/api/attempts/${id}/answer`, { session, index, choice, ms });
  assert.equal((await ans(0, 0)).statusCode, 400); // no rounds built yet
  await app.inject(`/api/attempts/${id}/rounds?session=${s}`);
  const key = JSON.parse(app.db.prepare('SELECT content FROM attempt WHERE id = ?').get(id).content);
  assert.equal((await ans(99, 0)).json().error, 'bad_index');
  assert.equal((await ans(0, 5)).statusCode, 400);
  const r = await ans(0, key[0].answer, 999999);
  assert.deepEqual(r.json(), { correct: true, correctChoice: key[0].answer, points: 6 }); // clamped to the limit: no bonus
  assert.equal(app.db.prepare('SELECT ms FROM answer WHERE attempt_id = ? AND idx = 0').get(id).ms, 12000);
  assert.equal((await ans(0, 1)).json().error, 'already_answered');
  assert.equal((await ans(1, null)).json().correct, false);
  assert.equal((await ans(2, 0, 1, 'bad')).statusCode, 401);

  const real = ROUND_POINTS.quiz;
  ROUND_POINTS.quiz = (c) => (c ? 10 : 0);
  try {
    assert.equal((await ans(2, key[2].answer)).json().points, 10);
    assert.equal((await ans(3, key[3].answer)).json().points, 10);
    const res = await post(app, `/api/attempts/${id}/result`, { score: 100, durationMs: 9000 });
    assert.equal(res.json().score, 26); // 6 (answer 0) + 10 + 10
    assert.equal((await ans(4, 0)).json().error, 'finished');
  } finally { ROUND_POINTS.quiz = real; }
  await app.close();
});

test('quiz import: quoted commas, bad rows reported, upsert; list and delete', async () => {
  const { app, h } = await adminApp();
  const body = [
    '# comment', 'question,correct,wrong1,wrong2,wrong3,category',
    '"¿Cuánto es 1,5 + 1,5?","3,0",2,4,5,mates',
    'Pregunta repetida,a,a,b,c,x',
    'Corta,a,b,c',
    `${'x'.repeat(111)},a,b,c,d`,
    'Capital de Francia,París,Roma,Madrid,Berlín',
  ].join('\n');
  const r = (await csv(app, h, '/api/admin/content/quiz/import', body)).json();
  assert.deepEqual([r.added, r.updated], [2, 0]);
  assert.deepEqual(r.errors.map((e) => [e.line, e.error]), [[4, 'duplicate_answers'], [5, 'empty_field'], [6, 'question_too_long']]);
  assert.equal(app.db.prepare('SELECT correct FROM quiz_question WHERE question LIKE ?').get('¿Cuánto%').correct, '3,0');
  const again = (await csv(app, h, '/api/admin/content/quiz/import', '"¿Cuánto es 1,5 + 1,5?",3,2,4,5\n')).json();
  assert.deepEqual([again.added, again.updated], [0, 1]);
  const list = (await app.inject({ url: '/api/admin/content/quiz', headers: h })).json();
  assert.equal(list.length, 2);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/content/quiz/' + list[0].id, headers: h })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/content/quiz/9999', headers: h })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/admin/content/nope', headers: h })).statusCode, 404);
  assert.equal((await csv(app, {}, '/api/admin/content/quiz/import', 'x')).statusCode, 401);
  await app.close();
});

test('pixel import: missing_file and invalid names', async () => {
  const { app, h } = await adminApp();
  const f = join(PIXEL_DIR, '__test.png');
  writeFileSync(f, 'x');
  try {
    const r = (await csv(app, h, '/api/admin/content/pixel/import', 'file,label,group\n__test.png,Sede,lugares\nnope.jpg,X,y\n../etc.png,Y,z\n')).json();
    assert.deepEqual([r.added, r.updated], [1, 0]);
    assert.deepEqual(r.errors.map((e) => e.error), ['missing_file', 'invalid_file']);
    assert.equal((await app.inject('/content/pixel/__test.png')).statusCode, 200);
    assert.equal((await app.inject('/content/pixel/..%2fdb.ts')).statusCode, 404);
  } finally { rmSync(f, { force: true }); }
  await app.close();
});

test('game params: numbers only', async () => {
  const { app, h } = await adminApp();
  const put = (params) => app.inject({ method: 'PUT', url: '/api/admin/games/quiz', payload: { params }, headers: h });
  assert.equal((await put({ questions: 5 })).statusCode, 200);
  assert.equal((await put({ questions: 'x' })).statusCode, 400);
  assert.equal((await put({ a: { b: 1 } })).statusCode, 400);
  await app.close();
});

test('params merge: existing DB keeps edited values and gains new default keys', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'fiesta-')), 'test.db');
  const db = openDb(f, CSV);
  db.prepare('UPDATE game_config SET params = ? WHERE game = ?').run('{"questions":7}', 'quiz');
  db.close();
  const again = openDb(f, CSV);
  const p = JSON.parse(again.prepare("SELECT params FROM game_config WHERE game = 'quiz'").get().params);
  assert.equal(p.questions, 7);
  assert.equal(p.secondsPerQuestion, 12);
  assert.equal(p.idleSeconds, 20);
  again.close();
});

test('roundsTotal: pixel adds the all-correct bonus, quiz just sums', async () => {
  const { roundsTotal } = await import('../src/shared/rounds.js');
  const twelve = Array.from({ length: 8 }, () => ({ points: 12 }));
  assert.equal(roundsTotal('pixel', twelve, 8), 100);
  assert.equal(roundsTotal('pixel', [...twelve.slice(1), { points: 0 }], 8), 84); // one miss: no bonus
  assert.equal(roundsTotal('pixel', twelve.slice(1), 8), 84); // one unanswered: no bonus
  assert.equal(roundsTotal('quiz', [{ points: 10 }, { points: 0 }, { points: 7 }], 10), 17);
});
