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

test('rejections: a rejected revalidation stays blocked and marked, and both kinds can still be approved later', async () => {
  const { app, h } = await adminApp();
  await put(app, '/api/admin/settings', { registrationValidation: 'manual' }, h);
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = 1').get();
  app.db.prepare('INSERT INTO registration(guest_id, pin, ticket_token, checkin_token, created_at) VALUES (1, ?, ?, ?, ?)').run('111222', 't-1', 'c-1', Date.now());
  await post(app, '/api/admin/guests/1/revalidate', undefined, h);
  await post(app, '/api/register', { name: 'Colado Nuevo', email: 'colado@example.com' });
  const pending = (await app.inject({ url: '/api/admin/verifications', headers: h })).json();
  assert.deepEqual(pending.map((v) => v.kind).sort(), ['new', 'revalidate']);
  const list = (await app.inject({ url: '/api/admin/guests?filter=revalidate', headers: h })).json();
  assert.deepEqual([list.counts.revalidate, list.counts.newInscriptions, list.guests.map((x) => x.id)], [1, 1, [1]]);
  const sum = () => app.inject({ url: '/api/admin/guests', headers: h }).then((r) => r.json().summary);
  assert.deepEqual(await sum(), { total: list.summary.total, confirmed: 0, onHold: 1, pending: 1, expected: 2, rejected: 0, accredited: 0 }); // on hold is not confirmed
  for (const v of pending) assert.equal((await post(app, `/api/admin/verifications/${v.id}/reject`, undefined, h)).statusCode, 200);

  const me = (await app.inject({ url: '/api/admin/guests', headers: h })).json().guests.find((x) => x.id === 1);
  assert.equal(me.rejected, true);
  assert.equal(me.onHold, false);
  assert.deepEqual([(await sum()).rejected, (await sum()).expected], [2, 0]); // the rejected guest and the rejected new inscription
  assert.equal((await post(app, '/api/login', { pin: '111222', screenId: 'screen-test-2' })).json().error, 'pending_validation');
  const rejected = (await app.inject({ url: '/api/admin/verifications?status=rejected', headers: h })).json();
  assert.equal(rejected.length, 2);

  const reval = rejected.find((v) => v.kind === 'revalidate'), fresh = rejected.find((v) => v.kind === 'new');
  assert.equal((await post(app, `/api/admin/verifications/${reval.id}/approve`, { guestId: 1 }, h)).json().ticketToken, 't-1');
  assert.equal((await post(app, '/api/login', { pin: '111222', screenId: 'screen-test-2' })).statusCode, 200);
  const added = await post(app, `/api/admin/verifications/${fresh.id}/approve`, { add: true }, h);
  assert.equal(added.statusCode, 200);
  assert.ok(app.db.prepare("SELECT 1 FROM guest g JOIN registration r ON r.guest_id = g.id WHERE g.name = 'Colado Nuevo'").get());
  assert.equal((await app.inject({ url: '/api/admin/verifications?status=rejected', headers: h })).json().length, 0);
  void g;
});

test('duplicate inscriptions: sending the form twice keeps one request, approving one clears its copies and reuses the guest by email', async () => {
  const { app, h } = await adminApp();
  await put(app, '/api/admin/settings', { registrationValidation: 'manual' }, h);
  const pend = async () => (await app.inject({ url: '/api/admin/verifications', headers: h })).json();
  await post(app, '/api/register', { name: 'Pablo IBAÑEZ', email: 'pibanez@pcr.energy' });
  await post(app, '/api/register', { name: 'Pablo Ibañez', email: ' PIBANEZ@pcr.energy ', dietary: 'Vegano' });
  let list = await pend();
  assert.equal(list.length, 1); // the second send updates the first request
  assert.deepEqual([list[0].name, list[0].dietary], ['Pablo Ibañez', 'Vegano']);
  await post(app, '/api/register', { name: 'Pablo Ibañez', email: 'pibanez@pcr.energy' }); // no dietary: the earlier one stays
  assert.equal((await pend())[0].dietary, 'Vegano');

  // Two copies that already exist (sent before this rule): approving one clears the other.
  app.db.prepare("INSERT INTO verification_request(name, dni, email, candidates, created_at) VALUES ('Pablo IBAÑEZ', '', 'pibanez@pcr.energy', '[]', ?)").run(Date.now());
  list = await pend();
  assert.equal(list.length, 2);
  const a = await post(app, `/api/admin/verifications/${list[0].id}/approve`, { add: true }, h);
  assert.equal(a.statusCode, 200);
  assert.deepEqual(await pend(), []);
  // A late copy with another spelling reuses the guest that has that email: no second guest, same ticket.
  app.db.prepare("INSERT INTO verification_request(name, dni, email, candidates, created_at) VALUES ('PABLO IBANEZ', '', 'pibanez@pcr.energy', '[]', ?)").run(Date.now());
  const late = (await pend())[0];
  const b = await post(app, `/api/admin/verifications/${late.id}/approve`, { add: true }, h);
  assert.equal(b.json().ticketToken, a.json().ticketToken);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM guest WHERE email = 'pibanez@pcr.energy'").get().n, 1);
  await app.close();
});

test('tester guest: plays every game again and again, even on hold, and never wins a prize or ranks', async () => {
  const { app, h } = await adminApp();
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = 1').get();
  const { ticketToken } = (await post(app, '/api/register', g)).json();
  const { pin } = (await app.inject('/api/ticket/' + ticketToken)).json();
  await post(app, '/api/admin/guests/1/revalidate', undefined, h); // on hold: a normal guest is locked out
  app.db.prepare('UPDATE guest SET tester = 1 WHERE id = 1').run();
  const login = await post(app, '/api/login', { pin, screenId: 'screen-tester-1' });
  assert.equal(login.statusCode, 200);
  const { session } = login.json();
  for (let i = 0; i < 3; i++) {
    const a = await post(app, '/api/attempts', { session, game: 'distinto' });
    assert.equal(a.statusCode, 200, 'over the attempt limit');
    app.db.prepare('UPDATE attempt SET score = 100, finished_at = ? WHERE id = ?').run(Date.now(), a.json().attemptId);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM attempt WHERE guest_id = 1 AND no_prize = 1').get().n, 3);
  const live = (await app.inject(`/api/live?screenId=screen-tester-1&session=${session}`)).json();
  assert.ok(live.games.find((x) => x.id === 'distinto').attemptsLeft > 0);
  await app.close();
});

test('prize: only the first game a guest plays can win it; later games still rank', async () => {
  const { app } = await adminApp();
  const g = app.db.prepare('SELECT name, email FROM guest WHERE id = 1').get();
  const { ticketToken } = (await post(app, '/api/register', g)).json();
  const { pin } = (await app.inject('/api/ticket/' + ticketToken)).json();
  const { session } = (await post(app, '/api/login', { pin, screenId: 'screen-first-1' })).json();
  const play = async (game, score) => {
    const a = (await post(app, '/api/attempts', { session, game })).json();
    app.db.prepare('UPDATE attempt SET started_at = started_at - 10000 WHERE id = ?').run(a.attemptId);
    return { a, r: (await post(app, `/api/attempts/${a.attemptId}/result`, { score, durationMs: 9000 })).json() };
  };
  const first = await play('distinto', 10); // below the threshold: the chance is used
  assert.equal(first.a.prizeEligible, true);
  assert.equal(first.r.prizeWon, false);
  const second = await play('memo', 100);
  assert.equal(second.a.prizeEligible, false);
  assert.equal(second.r.prizeWon, false);
  assert.equal(app.db.prepare('SELECT prize_won_at FROM registration WHERE guest_id = 1').get().prize_won_at, null);
  assert.equal(app.db.prepare('SELECT no_prize FROM attempt WHERE id = ?').get(second.a.attemptId).no_prize, 0); // still ranks
  await app.close();
});
