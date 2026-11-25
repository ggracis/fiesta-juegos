import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/index.ts';

const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
const put = (app, url, payload, headers) => app.inject({ method: 'PUT', url, payload, headers });
async function adminApp() {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret' });
  const res = await post(app, '/api/admin/login', { password: 'secret' });
  return { app, h: { cookie: res.headers['set-cookie'].split(';')[0] } };
}

test('manual validation: a new or listed guest waits for staff, a registered one gets the ticket back', async () => {
  const { app, h } = await adminApp();
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = 1').get();
  const first = (await post(app, '/api/register', g)).json(); // registered before the switch
  assert.equal(first.status, 'registered');
  assert.equal((await put(app, '/api/admin/settings', { registrationValidation: 'manual' }, h)).statusCode, 200);
  assert.equal((await post(app, '/api/register', g)).json().ticketToken, first.ticketToken);
  const listed = app.db.prepare('SELECT name, email FROM guest WHERE id = 2').get();
  assert.equal((await post(app, '/api/register', listed)).json().status, 'pending');
  assert.equal((await post(app, '/api/register', { name: 'Persona Nueva', email: 'nueva@example.com' })).json().status, 'pending');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM verification_request WHERE status = 'pending'").get().n, 2);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM registration').get().n, 1);
});

test('a guest taken out of the raffles is never drawn', async () => {
  const { app, h } = await adminApp();
  for (const id of [1, 2]) {
    const g = app.db.prepare('SELECT name, email FROM guest WHERE id = ?').get(id);
    await post(app, '/api/register', g);
    await post(app, `/api/admin/guests/${id}/checkin`, undefined, h); // event day in tests: only checked-in guests are drawn
  }
  const r = await post(app, '/api/admin/guests/1/raffle', { participates: false }, h);
  assert.deepEqual(r.json(), { participates: false });
  const list = (await app.inject({ url: '/api/admin/guests', headers: h })).json().guests;
  assert.equal(list.find((x) => x.id === 1).raffleOut, true);
  const ids = new Set();
  for (let i = 0; i < 2; i++) {
    const d = await post(app, '/api/admin/raffle', undefined, h);
    if (d.statusCode === 200) ids.add(app.db.prepare('SELECT guest_id FROM raffle WHERE id = ?').get(d.json().id).guest_id);
  }
  assert.deepEqual([...ids], [2]); // the second draw finds nobody left
  await post(app, '/api/admin/guests/1/raffle', { participates: true }, h);
  assert.equal((await post(app, '/api/admin/raffle', undefined, h)).statusCode, 200);
});

test('revalidar: QR and PIN stop working until a verification approves the same ticket again', async () => {
  const { app, h } = await adminApp();
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = 1').get();
  const { ticketToken } = (await post(app, '/api/register', g)).json();
  const t = (await app.inject('/api/ticket/' + ticketToken)).json();
  const login = () => post(app, '/api/login', { pin: t.pin, screenId: 'screen-test-1' });
  assert.equal((await login()).statusCode, 200);

  assert.deepEqual((await post(app, '/api/admin/guests/1/revalidate', undefined, h)).json(), { onHold: true });
  assert.equal((await post(app, '/api/admin/guests/1/revalidate', undefined, h)).json().error, 'already_pending');
  const blocked = await login();
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'pending_validation');
  assert.equal((await post(app, '/api/admin/checkin/' + t.checkinToken, { action: 'checkin' }, h)).json().error, 'pending_validation');
  assert.equal((await post(app, '/api/admin/guests/1/checkin', undefined, h)).json().error, 'pending_validation');
  const list = (await app.inject({ url: '/api/admin/guests', headers: h })).json().guests;
  assert.equal(list.find((x) => x.id === 1).onHold, true);

  const v = app.db.prepare("SELECT id FROM verification_request WHERE status = 'pending'").get();
  const ok = (await post(app, `/api/admin/verifications/${v.id}/approve`, { guestId: 1 }, h)).json();
  assert.equal(ok.ticketToken, ticketToken); // same ticket, same PIN
  assert.equal(ok.pin, t.pin);
  assert.equal((await login()).statusCode, 200);
  assert.equal((await post(app, '/api/admin/checkin/' + t.checkinToken, { action: 'checkin' }, h)).statusCode, 200);
});
