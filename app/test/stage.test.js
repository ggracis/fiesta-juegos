import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/index.ts';
import { DEFAULT_STAGE, CUE_LEAD_MS, CUE_STEP_MS, PANELS, cueDelay, cueMs } from '../src/shared/stage.js';

const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
const put = (app, url, payload, headers) => app.inject({ method: 'PUT', url, payload, headers });
async function adminApp() {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  const res = await post(app, '/api/admin/login', { password: 'secret' });
  return { app, h: { cookie: res.headers['set-cookie'].split(';')[0] } };
}
const live = async (app) => (await app.inject('/api/live')).json();
async function checkedIn(app, h, id) {
  const g = app.db.prepare('SELECT name, dni, email FROM guest WHERE id = ?').get(id);
  const { ticketToken } = (await post(app, '/api/register', { name: g.name, dni: g.dni, email: g.email })).json();
  const t = (await app.inject('/api/ticket/' + ticketToken)).json();
  await post(app, '/api/admin/checkin/' + t.checkinToken, { action: 'checkin' }, h);
  return t.pin;
}

test('stage: defaults in live, admin-only switching, merge and clamp', async () => {
  const { app, h } = await adminApp();
  let s = (await live(app)).stage;
  assert.equal(s.scene, 'title');
  assert.deepEqual(s.speaker, DEFAULT_STAGE.speakers[0]);
  assert.equal(s.speakerCount, DEFAULT_STAGE.speakers.length);
  assert.equal(s.winner, null);

  assert.equal((await put(app, '/api/admin/stage', { scene: 'speaker' })).statusCode, 401);
  assert.equal((await app.inject('/api/admin/stage')).statusCode, 401);
  const r = (await put(app, '/api/admin/stage', { scene: 'speaker', speaker: 2 }, h)).json();
  assert.equal(r.scene, 'speaker');
  assert.ok(r.at > 0);
  s = (await live(app)).stage;
  assert.equal(s.scene, 'speaker');
  assert.deepEqual(s.speaker, DEFAULT_STAGE.speakers[2]);

  // New list: trimmed, empty names dropped, index clamped to the new length.
  const list = [{ name: '  Ana Paz ', role: ' Anfitriona ' }, { name: 'Bin Bin' }];
  const m = (await put(app, '/api/admin/stage', { speakers: list }, h)).json();
  assert.deepEqual(m.speakers, [{ name: 'Ana Paz', role: 'Anfitriona' }, { name: 'Bin Bin', role: '' }]);
  assert.equal(m.speaker, 1);
  assert.equal(m.scene, 'speaker'); // untouched keys survive a partial patch
  assert.deepEqual((await put(app, '/api/admin/stage', { prizes: [' TV 55" ', '', 'Notebook'] }, h)).json().prizes, ['TV 55"', 'Notebook']);
  assert.deepEqual((await app.inject({ url: '/api/admin/stage', headers: h })).json().prizes, ['TV 55"', 'Notebook']);

  for (const bad of [{}, { scene: 'nope' }, { speaker: -1 }, { speakers: [{ name: '' }] }, { speakers: [{ name: 'x', pin: '1' }] },
    { video: 'javascript:alert(1)' }, { video: '<x>' }, { winner: 99 }, { extra: 1 }]) {
    assert.equal((await put(app, '/api/admin/stage', bad, h)).statusCode, 400, JSON.stringify(bad));
  }
  for (const ok of ['media/intro.mp4', '/media/intro.mp4', 'https://cdn.example.com/a b.mp4'.replace(' ', '%20'), '']) {
    assert.equal((await put(app, '/api/admin/stage', { video: ok }, h)).statusCode, 200, ok);
  }
  await app.close();
});

test('stage: a draw carries the prize, switches the stage to the winner, past winners are recallable', async () => {
  const { app, h } = await adminApp();
  const pins = [];
  for (const id of [1, 2]) pins.push(await checkedIn(app, h, id));
  assert.equal((await post(app, '/api/admin/raffle', { prize: 'x'.repeat(81) }, h)).statusCode, 400);
  assert.equal((await post(app, '/api/admin/raffle', { prize: 5 }, h)).statusCode, 400);
  const first = (await post(app, '/api/admin/raffle', { prize: '  Smart TV   55"  ' }, h)).json();
  assert.equal(first.prize, 'Smart TV 55"');
  let l = await live(app);
  assert.equal(l.raffle.prize, 'Smart TV 55"');
  assert.equal(l.stage.scene, 'winner');
  assert.deepEqual(l.stage.winner, { id: first.id, name: first.name, prize: 'Smart TV 55"', drawnAt: first.drawnAt }); // no other guests' names

  const second = (await post(app, '/api/admin/raffle', undefined, h)).json(); // no body: still works, no prize
  assert.equal(second.prize, '');
  assert.equal((await live(app)).stage.winner.id, second.id);
  const winners = (await app.inject({ url: '/api/admin/raffle', headers: h })).json();
  assert.deepEqual(winners.map((w) => w.prize), ['Smart TV 55"', '']);

  await put(app, '/api/admin/stage', { scene: 'winner', winner: first.id }, h); // recall an earlier plate
  l = await live(app);
  assert.equal(l.stage.winner.name, first.name);
  for (const pin of pins) assert.ok(!JSON.stringify(l).includes(pin));
  assert.ok(!/"pin"|ticket|checkin|dni|email/i.test(JSON.stringify(l.stage)));
  await app.close();
});

test('stage: WOW cue is scheduled ahead on the server clock and lands on the title', async () => {
  const { app, h } = await adminApp();
  await put(app, '/api/admin/stage', { scene: 'black' }, h);
  assert.equal((await post(app, '/api/admin/stage/cue')).statusCode, 401);
  const before = Date.now();
  const r = (await post(app, '/api/admin/stage/cue', undefined, h)).json();
  assert.ok(r.cueAt >= before + CUE_LEAD_MS && r.cueAt <= Date.now() + CUE_LEAD_MS);
  const s = (await live(app)).stage;
  assert.equal(s.scene, 'title');
  assert.equal(s.cueAt, r.cueAt);
  await app.close();
});

test('cue timeline: panel 1 -> 4 then the stage, same frame whatever the local clock', () => {
  assert.equal(cueDelay(1), 0);
  assert.equal(cueDelay(4), 3 * CUE_STEP_MS);
  assert.equal(cueDelay(PANELS + 1), PANELS * CUE_STEP_MS); // the stage comes last
  assert.equal(cueDelay(0), 0); // unknown slot: plays with panel 1
  assert.equal(cueDelay(99), cueDelay(PANELS + 1));
  const cueAt = 10_000;
  assert.equal(cueMs(cueAt - 1, 0, cueAt, 1), -1);
  assert.equal(cueMs(cueAt + 2 * CUE_STEP_MS, 0, cueAt, 3), 0);
  assert.equal(cueMs(cueAt - 300, 300, cueAt, 2), cueMs(cueAt + 900, -900, cueAt, 2)); // clocks differ, same server instant
});
