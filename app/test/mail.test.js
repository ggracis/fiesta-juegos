import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/index.ts';
import { mailIdle } from '../server/mail.ts';

const realFetch = globalThis.fetch;
const env = { ...process.env };
let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response('{}', { status: 201 }); };
  process.env.BREVO_API_KEY = 'test-key';
  process.env.PUBLIC_URL = 'https://galadigitalpower.com.ar';
  delete process.env.MAIL_REDIRECT_TO;
});
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...env }; });

const setup = async () => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret', doorPassword: 'puerta' });
  app.db.prepare("INSERT INTO guest(name, email) VALUES ('Zoe Quiroga Test', 'zoe@example.com')").run();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'puerta' } });
  return { app, door: { cookie: res.headers['set-cookie'].split(';')[0] } };
};
const register = (app, payload = { name: 'Zoe Quiroga Test', email: 'zoe@example.com' }) => app.inject({ method: 'POST', url: '/api/register', payload });
const guestId = (app) => app.db.prepare("SELECT id FROM guest WHERE name = 'Zoe Quiroga Test'").get().id;

test('no key: nothing is fetched', async () => {
  delete process.env.BREVO_API_KEY;
  const { app } = await setup();
  assert.equal((await register(app)).json().status, 'registered');
  await mailIdle();
  assert.equal(calls.length, 0);
});

test('new registration sends one email through Brevo', async () => {
  const { app } = await setup();
  await register(app);
  await mailIdle();
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(init.headers['api-key'], 'test-key');
  assert.deepEqual(body.sender, { name: 'Digital Power - Gala 2026', email: 'invitaciones@galadigitalpower.com.ar' });
  assert.deepEqual(body.to, [{ email: 'zoe@example.com' }]);
  assert.equal(body.subject, 'Tu entrada · Digital Power - Gala 2026');
  assert.match(body.htmlContent, /\/api\/ticket\/[\w-]+\/qr\.png/);
  assert.ok(body.textContent.includes('PIN'));
  assert.ok(app.db.prepare('SELECT email_sent_at FROM registration').get().email_sent_at);
});

test('MAIL_REDIRECT_TO changes the recipient and prefixes the subject', async () => {
  process.env.MAIL_REDIRECT_TO = 'org@example.com';
  const { app } = await setup();
  await register(app);
  await mailIdle();
  assert.deepEqual(calls[0].body.to, [{ email: 'org@example.com' }]);
  assert.equal(calls[0].body.subject, '[PRUEBA → zoe@example.com] Tu entrada · Digital Power - Gala 2026');
});

test('lost-ticket recovery does not send again', async () => {
  const { app } = await setup();
  const first = (await register(app)).json();
  await mailIdle();
  const again = (await register(app)).json();
  await mailIdle();
  assert.equal(again.ticketToken, first.ticketToken);
  assert.equal(calls.length, 1);
});

test('approving a pending verification emails the request address', async () => {
  const { app, door } = await setup();
  const r = await register(app, { name: 'Persona Desconocida', email: 'nueva@example.com' });
  assert.equal(r.json().status, 'pending');
  await mailIdle();
  assert.equal(calls.length, 0);
  const id = app.db.prepare('SELECT id FROM verification_request').get().id;
  const ok = await app.inject({ method: 'POST', url: `/api/admin/verifications/${id}/approve`, headers: door, payload: { add: true } });
  assert.equal(ok.statusCode, 200);
  await mailIdle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.to, [{ email: 'nueva@example.com' }]);
  await app.inject({ method: 'POST', url: `/api/admin/verifications/${id}/approve`, headers: door, payload: { add: true } }); // replay
  await mailIdle();
  assert.equal(calls.length, 1);
});

test('resend works and is rate-limited to once per 60 s', async () => {
  const { app, door } = await setup();
  await register(app);
  await mailIdle();
  const id = guestId(app);
  app.db.prepare('UPDATE registration SET email_sent_at = ?').run(Date.now() - 61_000);
  const url = `/api/admin/guests/${id}/resend-email`;
  assert.equal((await app.inject({ method: 'POST', url, headers: door })).statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal((await app.inject({ method: 'POST', url, headers: door })).json().error, 'too_soon');
  assert.equal(calls.length, 2);
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
});

test('QR endpoint: png for a ticket, 404 otherwise', async () => {
  const { app } = await setup();
  const { ticketToken } = (await register(app)).json();
  const res = await app.inject({ url: `/api/ticket/${ticketToken}/qr.png` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.match(res.headers['cache-control'], /max-age=\d{6,}/);
  assert.equal(res.rawPayload.subarray(1, 4).toString(), 'PNG');
  assert.equal((await app.inject({ url: '/api/ticket/nope/qr.png' })).statusCode, 404);
});
