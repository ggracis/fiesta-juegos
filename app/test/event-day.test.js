import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
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
async function register(app, id) {
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = ?').get(id);
  const { ticketToken } = (await post(app, '/api/register', { name: g.name, email: g.email })).json();
  return (await app.inject('/api/ticket/' + ticketToken)).json();
}
// Runs fn with check-in closed (event day in the future), then restores the suite default (open).
async function beforeEventDay(fn) {
  const prev = process.env.CHECKIN_FROM;
  process.env.CHECKIN_FROM = String(Date.now() + 86_400_000);
  try { await fn(); } finally { process.env.CHECKIN_FROM = prev; }
}

test('check-in is refused before event day, walk-ins still get a ticket', async () => {
  const { app, h } = await adminApp();
  await beforeEventDay(async () => {
    const t = await register(app, 1);
    const byToken = await post(app, '/api/admin/checkin/' + t.checkinToken, { action: 'checkin' }, h);
    assert.equal(byToken.statusCode, 409);
    assert.equal(byToken.json().error, 'checkin_not_open');
    const byId = await post(app, '/api/admin/guests/1/checkin', undefined, h);
    assert.equal(byId.statusCode, 409);
    assert.equal(byId.json().error, 'checkin_not_open');
    const w = await post(app, '/api/admin/guests/2/walkin', undefined, h);
    assert.equal(w.statusCode, 200);
    assert.ok(w.json().ticketToken);
    assert.equal((await app.inject({ url: '/api/admin/guests/2', headers: h })).json().checkedInAt, null);
  });
  assert.equal((await post(app, '/api/admin/guests/1/checkin', undefined, h)).statusCode, 200); // open again
  await app.close();
});

test('raffle: rehearsal draws before event day, reset deletes them all', async () => {
  const { app, h } = await adminApp();
  await beforeEventDay(async () => {
    await register(app, 1);
    await register(app, 2);
    const d = await post(app, '/api/admin/raffle', { prize: 'Prueba' }, h); // nobody checked in: the pool is every registration
    assert.equal(d.statusCode, 200);
    await post(app, '/api/admin/raffle', undefined, h);
    assert.equal((await app.inject({ url: '/api/admin/raffle', headers: h })).json().length, 2);
    assert.equal((await post(app, '/api/admin/raffle/reset')).statusCode, 401);
    assert.deepEqual((await post(app, '/api/admin/raffle/reset', undefined, h)).json(), { deleted: 2 });
    assert.deepEqual((await app.inject({ url: '/api/admin/raffle', headers: h })).json(), []);
    const s = (await app.inject('/api/live')).json().stage;
    assert.equal(s.scene, 'raffle');
    assert.equal(s.winner, null);
    assert.equal((await post(app, '/api/admin/raffle', undefined, h)).statusCode, 200); // the pool is whole again
  });
  assert.equal((await post(app, '/api/admin/raffle', undefined, h)).statusCode, 409); // event day: only checked-in guests are drawn
  await app.close();
});

test('guests.csv: staff only, BOM, ; separated, dietary normalised, Buenos Aires times', async () => {
  const { app, h } = await adminApp();
  const t1 = await register(app, 1), t2 = await register(app, 2);
  app.db.prepare('UPDATE registration SET dietary = ? WHERE guest_id = 1').run('Celíaca; sin lactosa');
  app.db.prepare('UPDATE registration SET dietary = ? WHERE guest_id = 2').run(' No ');
  await post(app, '/api/admin/checkin/' + t1.checkinToken, { action: 'checkin' }, h);
  app.db.prepare('UPDATE registration SET checked_in_at = ?, created_at = ? WHERE guest_id = 1').run(Date.parse('2026-11-30T21:05:00-03:00'), Date.parse('2026-11-01T09:00:00-03:00'));
  assert.equal((await app.inject('/api/admin/guests.csv')).statusCode, 401);
  const r = await app.inject({ url: '/api/admin/guests.csv', headers: h });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-disposition'], /invitados-gala\.csv/);
  assert.ok(r.body.startsWith('﻿Nombre;Email;Estado;Restricciones alimentarias;Inscripto el;Acreditado el;Origen\r\n'));
  const g1 = app.db.prepare('SELECT name FROM guest WHERE id = 1').get().name, g2 = app.db.prepare('SELECT name FROM guest WHERE id = 2').get().name;
  const line = (name) => r.body.split('\r\n').find((l) => l.startsWith(name + ';'));
  assert.match(line(g1), /;Acreditado;"Celíaca; sin lactosa";2026-11-01 09:00;2026-11-30 21:05;Lista$/);
  assert.match(line(g2), /;Inscripto;;/); // "No" becomes empty
  assert.ok(!line(g2).includes('No'));
  assert.equal(r.body.split('\r\n').length - 2, app.db.prepare('SELECT COUNT(*) AS n FROM guest').get().n); // header + one row per guest + trailing newline
  assert.equal((await app.inject({ url: '/api/admin/guests.csv' })).statusCode, 401);
  await app.close();
});

test('guests.csv: shows revalidate, rejected, pending and rejected new inscriptions, and who was added by hand', async () => {
  const { app, h } = await adminApp();
  await register(app, 1); await register(app, 2);
  await post(app, '/api/admin/guests/1/revalidate', undefined, h);
  app.db.prepare('UPDATE registration SET on_hold = 2 WHERE guest_id = 2').run();
  await put(app, '/api/admin/settings', { registrationValidation: 'manual' }, h);
  await post(app, '/api/register', { name: 'Persona Nueva', email: 'nueva@example.com', dietary: 'Vegano' });
  await post(app, '/api/register', { name: 'Persona Rechazada', email: 'rech@example.com' });
  const rej = app.db.prepare("SELECT id FROM verification_request WHERE email = 'rech@example.com'").get();
  await post(app, `/api/admin/verifications/${rej.id}/reject`, undefined, h);
  app.db.prepare("INSERT INTO guest(name, email, walk_in) VALUES ('Mano Puerta', 'mano@example.com', 1)").run();
  const body = (await app.inject({ url: '/api/admin/guests.csv', headers: h })).body;
  assert.ok(body.startsWith('﻿Nombre;Email;Estado;Restricciones alimentarias;Inscripto el;Acreditado el;Origen\r\n'));
  const line = (name) => body.split('\r\n').find((l) => l.startsWith(name + ';'));
  const name = (id) => app.db.prepare('SELECT name FROM guest WHERE id = ?').get(id).name;
  assert.match(line(name(1)), /;Por revalidar;/);
  assert.match(line(name(2)), /;Rechazado;/);
  assert.match(line(name(3)), /;Sin inscribir;.*;Lista$/);
  assert.match(line('Persona Nueva'), /^Persona Nueva;nueva@example\.com;Inscripción nueva \(por aprobar\);Vegano;\d{4}-.*;;Formulario$/);
  assert.match(line('Persona Rechazada'), /;Inscripción nueva rechazada;.*;Formulario$/);
  assert.match(line('Mano Puerta'), /;Sin inscribir;.*;Agregado a mano$/);
  await app.close();
});

test('speaker photos: path kept, bad paths rejected, image upload leaves the video alone', async () => {
  const { app, h } = await adminApp();
  const r = await put(app, '/api/admin/stage', { speakers: [{ name: 'Ana', role: 'CEO', photo: 'media/ana-1.jpg' }, { name: 'Bin', photo: '' }] }, h);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().speakers, [{ name: 'Ana', role: 'CEO', photo: 'media/ana-1.jpg' }, { name: 'Bin', role: '' }]);
  assert.equal((await app.inject('/api/live')).json().stage.speaker.photo, 'media/ana-1.jpg');
  for (const photo of ['http://evil.example/a.jpg', 'media/../a.jpg', '/etc/passwd', 'media/a.gif', 'media/a.jpg?x=1']) {
    assert.equal((await put(app, '/api/admin/stage', { speakers: [{ name: 'Ana', photo }] }, h)).statusCode, 400, photo);
  }

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(32)]);
  assert.equal((await post(app, '/api/admin/media/image', png, { 'content-type': 'image/png' })).statusCode, 401);
  const up = await post(app, '/api/admin/media/image', png, { ...h, 'content-type': 'image/png' });
  assert.equal(up.statusCode, 200);
  const { path } = up.json();
  try {
    assert.match(path, /^media\/[\w.-]+\.png$/);
    assert.ok(existsSync(join(MEDIA_DIR, path.slice(6))));
    assert.equal((await app.inject({ url: '/api/admin/stage', headers: h })).json().video, ''); // the video did not change
    assert.equal((await put(app, '/api/admin/stage', { speakers: [{ name: 'Ana', photo: path }] }, h)).statusCode, 200);
  } finally { rmSync(join(MEDIA_DIR, path.slice(6)), { force: true }); }
  assert.equal((await post(app, '/api/admin/media/image', Buffer.from('not an image at all'), { ...h, 'content-type': 'image/png' })).statusCode, 400);
  assert.equal((await post(app, '/api/admin/media/image', png, { ...h, 'content-type': 'image/jpeg' })).statusCode, 400); // type and bytes must agree
  await app.close();
});

test('awards: 18 defaults, saved and clamped, current one public in live', async () => {
  const { app, h } = await adminApp();
  assert.equal(DEFAULT_STAGE.awards.length, 18);
  let s = (await app.inject('/api/live')).json().stage;
  assert.equal(s.awardCount, 18);
  assert.deepEqual(s.award, { company: 'SECCO', text: 'Biggest PV Project in Santa Fe' });
  assert.equal(DEFAULT_STAGE.awards[8].text, 'TOP INSTALLER HUAWEI');

  const r = await put(app, '/api/admin/stage', { scene: 'award', award: 2 }, h);
  assert.equal(r.statusCode, 200);
  s = (await app.inject('/api/live')).json().stage;
  assert.equal(s.scene, 'award');
  assert.deepEqual([s.awardIndex, s.award.company], [2, 'ARENGY']);

  const list = [{ company: '  Acme  Solar ', text: ' Mejor   proyecto ' }, { company: 'Beta' }, { company: '  ' }];
  const m = (await put(app, '/api/admin/stage', { awards: list, award: 9 }, h)).json();
  assert.deepEqual(m.awards, [{ company: 'Acme Solar', text: 'Mejor proyecto' }, { company: 'Beta', text: '' }]);
  assert.equal(m.award, 1); // clamped to the new list
  assert.equal((await app.inject('/api/live')).json().stage.award.company, 'Beta');
  for (const bad of [{ award: -1 }, { award: 100 }, { awards: [{ company: '' }] }, { awards: [{ text: 'x' }] }, { awards: [{ company: 'x'.repeat(81) }] },
    { awards: [{ company: 'x', text: 'y'.repeat(121) }] }, { awards: Array(61).fill({ company: 'x' }) }, { awards: [{ company: 'x', extra: 1 }] }]) {
    assert.equal((await put(app, '/api/admin/stage', bad, h)).statusCode, 400, JSON.stringify(bad));
  }
  await app.close();
});
