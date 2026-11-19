import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { buildApp } from '../server/index.ts';
import { MEDIA_DIR } from '../server/lib.ts';
import { DEFAULT_STAGE } from '../src/shared/stage.js';

const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
const put = (app, url, payload, headers) => app.inject({ method: 'PUT', url, payload, headers });
async function adminApp() {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  const res = await post(app, '/api/admin/login', { password: 'secret' });
  return { app, h: { cookie: res.headers['set-cookie'].split(';')[0] } };
}
const live = async (app) => (await app.inject('/api/live')).json();
const winners = async (app, h) => (await app.inject({ url: '/api/admin/raffle', headers: h })).json();
async function checkedIn(app, h, id) {
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = ?').get(id);
  const { ticketToken } = (await post(app, '/api/register', { name: g.name, email: g.email })).json();
  const t = (await app.inject('/api/ticket/' + ticketToken)).json();
  await post(app, '/api/admin/checkin/' + t.checkinToken, { action: 'checkin' }, h);
}
const fakeMp4 = (extra = 64) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(extra, 7)]);

test('ambient phrases: defaults, trimmed, bounded, public in live', async () => {
  const { app, h } = await adminApp();
  assert.deepEqual((await live(app)).stage.ambient, DEFAULT_STAGE.ambient);
  assert.equal((await put(app, '/api/admin/stage', { ambient: ['x'] })).statusCode, 401);
  const r = await put(app, '/api/admin/stage', { ambient: ['  Hola   mundo ', '', 'Gracias'] }, h);
  assert.deepEqual(r.json().ambient, ['Hola mundo', 'Gracias']);
  assert.deepEqual((await live(app)).stage.ambient, ['Hola mundo', 'Gracias']);
  for (const bad of [{ ambient: ['x'.repeat(81)] }, { ambient: Array(21).fill('a') }, { ambient: [{}] }, { ambient: 1, extra: 1 }]) {
    assert.equal((await put(app, '/api/admin/stage', bad, h)).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await put(app, '/api/admin/stage', { ambient: [] }, h)).json().ambient, []); // empty: the stage falls back to its defaults
  await app.close();
});

test('media upload: admin only, MP4 only, stored under /media and set as the stage video', async () => {
  const { app, h } = await adminApp();
  const mp4 = { ...h, 'content-type': 'video/mp4' };
  assert.equal((await post(app, '/api/admin/media', fakeMp4(), { 'content-type': 'video/mp4' })).statusCode, 401);
  assert.equal((await post(app, '/api/admin/media', fakeMp4(), { ...h, 'content-type': 'application/octet-stream' })).statusCode, 415);
  assert.equal((await post(app, '/api/admin/media', 'hello', { ...h, 'content-type': 'text/plain' })).statusCode, 415);
  const notMp4 = await post(app, '/api/admin/media', Buffer.from('this is not a video file at all'), mp4); // right header, wrong bytes
  assert.equal(notMp4.statusCode, 400);
  assert.equal(notMp4.json().error, 'invalid_mp4');
  assert.equal((await post(app, '/api/admin/media', Buffer.alloc(0), mp4)).statusCode, 400);
  assert.equal((await live(app)).stage.video, '');

  const body = fakeMp4(5000);
  const ok = await post(app, '/api/admin/media', body, mp4);
  assert.equal(ok.statusCode, 200);
  const { video, size } = ok.json();
  try {
    assert.match(video, /^media\/\d+-[0-9a-f]{8}\.mp4$/);
    assert.equal(size, body.length);
    assert.equal((await live(app)).stage.video, video); // playback and offline copy go through the usual stage video path
    const got = await app.inject('/' + video);
    assert.equal(got.statusCode, 200);
    assert.deepEqual(got.rawPayload, body);
    assert.equal((await app.inject({ url: '/' + video, headers: { range: 'bytes=0-9' } })).statusCode, 206); // the browser seeks with ranges
  } finally { rmSync(join(MEDIA_DIR, video.replace('media/', '')), { force: true }); }
  await app.close();
});

test('raffle "Limpiar": clean plate, no winner on stage or panels', async () => {
  const { app, h } = await adminApp();
  assert.equal((await post(app, '/api/admin/raffle/clear')).statusCode, 401);
  await checkedIn(app, h, 1);
  await post(app, '/api/admin/raffle', { prize: 'TV' }, h);
  assert.equal((await live(app)).stage.scene, 'winner');
  assert.equal((await post(app, '/api/admin/raffle/clear', undefined, h)).statusCode, 204);
  const l = await live(app);
  assert.equal(l.stage.scene, 'raffle');
  assert.equal(l.stage.winner, null);
  assert.equal(l.raffle, null);
  await app.close();
});

test('raffle void: absent winner leaves every screen and later draws, the prize frees up', async () => {
  const { app, h } = await adminApp();
  for (const id of [1, 2]) await checkedIn(app, h, id);
  const first = (await post(app, '/api/admin/raffle', { prize: 'TV' }, h)).json();
  assert.equal((await post(app, `/api/admin/raffle/${first.id}/void`)).statusCode, 401);
  assert.equal((await post(app, '/api/admin/raffle/999/void', undefined, h)).statusCode, 404);
  assert.equal((await post(app, `/api/admin/raffle/${first.id}/void`, undefined, h)).statusCode, 204);
  assert.equal((await post(app, `/api/admin/raffle/${first.id}/void`, undefined, h)).statusCode, 409);
  let l = await live(app);
  assert.equal(l.raffle, null);
  assert.equal(l.stage.winner, null);
  assert.equal(l.stage.scene, 'raffle');
  assert.equal((await put(app, '/api/admin/stage', { winner: first.id }, h)).statusCode, 400); // a void draw cannot be recalled
  const list = await winners(app, h);
  assert.equal(list.length, 1);
  assert.ok(list[0].voidedAt > 0);

  const second = (await post(app, '/api/admin/raffle', { prize: 'TV' }, h)).json(); // same prize again
  assert.notEqual(second.name, first.name); // the absent guest stays out
  assert.equal((await post(app, '/api/admin/raffle', undefined, h)).statusCode, 409); // nobody left: both guests are in the raffle table
  l = await live(app);
  assert.equal(l.raffle.name, second.name);
  assert.equal(l.stage.winner.id, second.id);
  assert.equal((await winners(app, h)).filter((w) => !w.voidedAt).length, 1);
  await app.close();
});

test('prize winners: game and raffle prizes, voided excluded, delivery and CSV', async () => {
  const { app, h } = await adminApp();
  assert.equal((await app.inject('/api/admin/winners')).statusCode, 401);
  assert.equal((await app.inject('/api/admin/winners.csv')).statusCode, 401);
  for (const id of [1, 2, 3]) await checkedIn(app, h, id);
  const now = Date.now();
  app.db.prepare("INSERT INTO attempt(id, guest_id, seed, started_at, finished_at, score, game, prize_won) VALUES ('a1', 3, 1, ?, ?, 90, 'quiz', 1)").run(now - 5000, now - 4000);
  app.db.prepare('UPDATE registration SET prize_won_at = ?, prize_delivered_at = ? WHERE guest_id = 3').run(now - 4000, now - 1000);
  const a = (await post(app, '/api/admin/raffle', { prize: 'Notebook' }, h)).json();
  const b = (await post(app, '/api/admin/raffle', { prize: 'Tablet' }, h)).json();
  await post(app, `/api/admin/raffle/${b.id}/void`, undefined, h);

  let rows = (await app.inject({ url: '/api/admin/winners', headers: h })).json();
  assert.deepEqual(rows.map((r) => [r.kind, r.prize]), [['game', 'quiz'], ['raffle', 'Notebook']]);
  assert.ok(rows[0].deliveredAt && !rows[1].deliveredAt);
  assert.equal((await post(app, `/api/admin/raffle/${b.id}/deliver`, undefined, h)).statusCode, 404); // void draws are not delivered
  assert.equal((await post(app, `/api/admin/raffle/${a.id}/deliver`, undefined, h)).statusCode, 204);
  rows = (await app.inject({ url: '/api/admin/winners', headers: h })).json();
  assert.ok(rows[1].deliveredAt);

  const csv = await app.inject({ url: '/api/admin/winners.csv', headers: h });
  assert.match(csv.headers['content-type'], /text\/csv/);
  const lines = csv.body.trim().split('\n');
  assert.equal(lines[0], 'type,name,prize,won_at,delivered_at');
  assert.equal(lines.length, 3);
  assert.ok(lines[2].startsWith('raffle,') && lines[2].includes(',Notebook,'));
  assert.ok(!csv.body.includes('Tablet'));
  await app.close();
});
