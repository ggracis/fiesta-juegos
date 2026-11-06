import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../server/index.ts';
import { PIXEL_DIR } from '../server/lib.ts';
import { pixelPoints, pixelTotal } from '../src/shared/scoring.js';
import { buildRounds, mulberry32, ROUND_POINTS } from '../src/shared/rounds.js';
import demo from '../src/data/demo-content.json' with { type: 'json' };

const manifest = readFileSync(join(PIXEL_DIR, 'manifest.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));

test('pixelPoints: 12 within 2 s, −1 per started second, min 4, wrong = 0', () => {
  assert.equal(pixelPoints(true, 0), 12);
  assert.equal(pixelPoints(true, 2000), 12);
  assert.equal(pixelPoints(true, 2001), 11);
  assert.equal(pixelPoints(true, 5000), 9);
  assert.equal(pixelPoints(true, 10000), 4);
  assert.equal(pixelPoints(true, 60000), 4);
  assert.equal(pixelPoints(false, 500), 0);
  assert.equal(ROUND_POINTS.pixel, pixelPoints);
});

test('pixelTotal: +4 only when every round is correct', () => {
  const r = (correct, points) => ({ correct, points });
  assert.equal(pixelTotal(Array(8).fill(r(true, 12)), 8), 100);
  assert.equal(pixelTotal([...Array(7).fill(r(true, 12)), r(false, 0)], 8), 84);
  assert.equal(pixelTotal(Array(3).fill(r(true, 12)), 8), 36); // idle quit: no bonus
  assert.equal(pixelTotal([...Array(6).fill(r(true, 8)), r(false, 0), r(false, 0)], 8), 48); // client example
  assert.equal(pixelTotal([], 0), 0);
});

test('demo content: 12 images, neutral names, demo group, within size limits', () => {
  assert.equal(demo.pixel.length, 12);
  assert.deepEqual(demo.pixel.map((x) => [x.file, x.label, x.group]), manifest);
  for (const { file, label, group } of demo.pixel) {
    assert.match(file, /^img\d{2}\.jpg$/);
    assert.equal(group, 'demo');
    assert.ok(label.length <= 40);
    const path = join(PIXEL_DIR, file);
    assert.ok(statSync(path).size <= 400 * 1024, file);
    const b = readFileSync(path);
    let i = 2; // JPEG: walk the segments to the SOF marker for the width
    while (!(b[i + 1] >= 0xC0 && b[i + 1] <= 0xC2)) i += 2 + b.readUInt16BE(i + 2);
    assert.ok(b.readUInt16BE(i + 7) >= 1200, file);
  }
});

test('demo rounds: 8 images, 4 distinct options from the same group', () => {
  for (const seed of [1, 2, 3]) {
    const rounds = buildRounds('pixel', demo.pixel, 8, mulberry32(seed));
    assert.equal(rounds.length, 8);
    for (const r of rounds) {
      assert.equal(new Set(r.options).size, 4);
      assert.equal(r.options[r.answer], demo.pixel.find((x) => x.file === r.image).label);
      assert.ok(r.options.every((o) => demo.pixel.some((x) => x.label === o && x.group === 'demo')));
    }
  }
});

test('pixel rounds endpoint: no answer key in the response; answers score with pixelPoints', async () => {
  const app = buildApp(':memory:');
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = 1').get();
  const { ticketToken } = (await app.inject({ method: 'POST', url: '/api/register', payload: g })).json();
  const { pin } = (await app.inject('/api/ticket/' + ticketToken)).json();
  const session = (await app.inject({ method: 'POST', url: '/api/login', payload: { pin, screenId: 'screen-pixel-test' } })).json().session;
  const ins = app.db.prepare('INSERT INTO pixel_image(file, label, grp) VALUES (?,?,?)');
  for (const [file, label, group] of manifest) ins.run(file, label, group);
  const att = (await app.inject({ method: 'POST', url: '/api/attempts', payload: { session, game: 'pixel' } })).json();
  assert.ok(att.attemptId, 'pixel is ready and startable');

  const res = await app.inject(`/api/attempts/${att.attemptId}/rounds?session=${session}`);
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('answer'));
  const { rounds } = res.json();
  assert.equal(rounds.length, 8);
  for (const r of rounds) {
    assert.deepEqual(Object.keys(r).sort(), ['image', 'options', 'prompt']);
    assert.match(r.image, /^content\/pixel\/img\d{2}\.jpg$/);
  }
  assert.equal((await app.inject('/' + rounds[0].image)).statusCode, 200);

  const key = JSON.parse(app.db.prepare('SELECT content FROM attempt WHERE id = ?').get(att.attemptId).content);
  const ans = (index, choice, ms) => app.inject({ method: 'POST', url: `/api/attempts/${att.attemptId}/answer`, payload: { session, index, choice, ms } });
  assert.equal((await ans(0, key[0].answer, 1500)).json().points, 12);
  assert.equal((await ans(1, key[1].answer, 99999)).json().points, 4); // clamped to revealSeconds
  assert.equal((await ans(2, (key[2].answer + 1) % 4, 1000)).json().points, 0);
  assert.equal((await ans(3, null, 10000)).json().correct, false);
  await app.close();
});
