import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { buildApp } from '../server/index.ts';
import { readXlsx, exampleXlsx, XLSX_MIME } from '../server/xlsx.ts';

const login = async (app, password) => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password } });
  return { res, h: { cookie: res.headers['set-cookie']?.split(';')[0] } };
};
const setup = async (doorPassword = 'puerta') => {
  const app = buildApp(':memory:', undefined, { adminPassword: 'secret', doorPassword });
  return { app, door: (await login(app, 'puerta')).h, admin: (await login(app, 'secret')).h };
};
const importXlsx = (app, h, body) => app.inject({ method: 'POST', url: '/api/admin/guests/import', headers: { ...h, 'content-type': XLSX_MIME }, payload: body });

// Hand-built xlsx (deflated, shared strings, numeric DNI in exponent notation, empty cell kept positional) to mimic what Excel writes.
function excelLike() {
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>2.0123456E7</v></c><c r="C2" t="s"><v>4</v></c></row>'
    + '<row r="4"><c r="A4" t="s"><v>5</v></c><c r="C4" t="str"><v>x@y.com</v></c></row>'
    + '</sheetData></worksheet>';
  const files = {
    'xl/sharedStrings.xml': '<sst>' + ['Nombre', 'DNI', 'Email', 'Ana Gómez &amp; Co', 'ANA@Example.com', 'Zoe &lt;Z&gt;'].map((t) => `<si><t>${t}</t></si>`).join('') + '</sst>',
    'xl/worksheets/sheet1.xml': sheet,
  };
  const local = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(text), d = deflateRawSync(raw);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(raw), 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    local.push(l, n, d); central.push(c, n); off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}

test('door login works, empty DOOR_PASSWORD disables it', async () => {
  const { app, door } = await setup();
  assert.equal((await app.inject({ url: '/api/admin/me', headers: door })).json().role, 'door');
  const off = buildApp(':memory:', undefined, { adminPassword: 'secret', doorPassword: '' });
  assert.equal((await login(off, '')).res.statusCode, 401);
  assert.equal((await login(off, 'secret')).res.statusCode, 204);
});

test('door reaches only the Puerta endpoints', async () => {
  const { app, door, admin } = await setup();
  const id = app.db.prepare('SELECT id FROM guest LIMIT 1').get().id;
  for (const url of ['/api/admin/guests', '/api/admin/guests/' + id, '/api/admin/verifications', '/api/admin/state', '/api/admin/guests/example.xlsx'])
    assert.equal((await app.inject({ url, headers: door })).statusCode, 200, url);
  assert.deepEqual(Object.keys((await app.inject({ url: '/api/admin/state', headers: door })).json()), ['pendingVerifications']);
  assert.ok((await app.inject({ url: '/api/admin/state', headers: admin })).json().settings);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/guests/${id}/walkin`, headers: door })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/guests', headers: door, payload: { name: 'Pepe Puerta' } })).statusCode, 200);
  for (const [method, url] of [['GET', '/api/admin/attempts.csv'], ['GET', '/api/admin/winners'], ['GET', '/api/admin/stage'], ['GET', '/api/admin/raffle'], ['GET', '/api/admin/content/quiz'],
    ['GET', '/api/admin/ranking/distinto'], ['PUT', '/api/admin/settings'], ['PUT', '/api/admin/games/distinto'], ['POST', '/api/admin/raffle'], ['POST', '/api/admin/stage/cue'], ['POST', '/api/admin/media']])
    assert.equal((await app.inject({ method, url, headers: door, payload: method === 'GET' ? undefined : {} })).statusCode, 401, url);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE role = 'door'").get().n >= 3, true); // login, walk_in, add are logged as door
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/logout', headers: door })).statusCode, 204);
});

test('door can import a csv: 2 columns, and the legacy name,dni,email', async () => {
  const { app, door } = await setup();
  const csv = (payload) => app.inject({ method: 'POST', url: '/api/admin/guests/import', headers: { ...door, 'content-type': 'text/csv' }, payload });
  assert.equal((await csv('Nombre y apellido,Email\nDos Columnas,DOS@b.co\n')).json().added, 1);
  assert.equal(app.db.prepare("SELECT email FROM guest WHERE name = 'Dos Columnas'").get().email, 'dos@b.co');
  assert.equal((await csv('Nombre,DNI,Email\nCsv Persona,1.234.567,a@b.co\n')).json().added, 1);
  const g = app.db.prepare("SELECT dni, email FROM guest WHERE name = 'Csv Persona'").get();
  assert.deepEqual({ ...g }, { dni: null, email: 'a@b.co' }); // the email is the first cell with an @; the DNI is ignored, never stored
});

test('example.xlsx round-trips through the reader and the import endpoint', async () => {
  const { app, door } = await setup();
  const ex = await app.inject({ url: '/api/admin/guests/example.xlsx', headers: door });
  assert.match(ex.headers['content-disposition'], /invitados-ejemplo\.xlsx/);
  assert.deepEqual(readXlsx(ex.rawPayload), [['Nombre y apellido', 'Email'], ['Ejemplo Uno', 'ejemplo1@example.com'], ['Ejemplo Dos', 'ejemplo2@example.com']]);
  const r = await importXlsx(app, door, ex.rawPayload);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().added, 2);
  assert.equal(app.db.prepare("SELECT email FROM guest WHERE name = 'Ejemplo Uno'").get().email, 'ejemplo1@example.com');
  assert.equal((await importXlsx(app, door, ex.rawPayload)).json().added, 0); // idempotent
});

test('legacy 3-column xlsx (numeric DNI, shared strings, empty cell) still imports name + email', async () => {
  const rows = readXlsx(excelLike());
  assert.deepEqual(rows, [['Nombre', 'DNI', 'Email'], ['Ana Gómez & Co', '20123456', 'ANA@Example.com'], ['Zoe <Z>', '', 'x@y.com']]);
  const { app, door } = await setup();
  const r = await importXlsx(app, door, excelLike());
  assert.equal(r.json().added, 2);
  assert.equal(app.db.prepare("SELECT email FROM guest WHERE name = 'Ana Gómez & Co'").get().email, 'ana@example.com');
});

test('bad xlsx is rejected with file_invalid, header-only with file_empty', async () => {
  const { app, door } = await setup();
  assert.equal((await importXlsx(app, door, Buffer.from('not a zip'))).json().error, 'file_invalid');
  assert.equal((await importXlsx(app, door, exampleXlsx([['Nombre', 'Email']]))).json().error, 'file_empty');
});

test('door approves an unknown name with "add to the list and approve"', async () => {
  const { app, door } = await setup();
  const post = (url, payload) => app.inject({ method: 'POST', url, headers: door, payload });
  await app.inject({ method: 'POST', url: '/api/register', payload: { name: 'Persona Nueva', email: 'Nueva@X.com', dietary: 'vegano' } });
  const [v] = (await app.inject({ url: '/api/admin/verifications', headers: door })).json();
  assert.deepEqual([v.name, v.email, v.candidates, 'dni' in v], ['Persona Nueva', 'nueva@x.com', [], false]);
  assert.equal((await post(`/api/admin/verifications/${v.id}/approve`, {})).statusCode, 400); // needs a guest or add
  const a = await post(`/api/admin/verifications/${v.id}/approve`, { add: true });
  assert.equal(a.statusCode, 200);
  assert.match(a.json().pin, /^\d{6}$/);
  const g = app.db.prepare("SELECT id, email, walk_in FROM guest WHERE name = 'Persona Nueva'").get();
  assert.deepEqual({ email: g.email, walk_in: g.walk_in }, { email: 'nueva@x.com', walk_in: 1 });
  assert.equal(app.db.prepare('SELECT dietary FROM registration WHERE guest_id = ?').get(g.id).dietary, 'vegano');
  assert.equal((await post(`/api/admin/verifications/${v.id}/approve`, { add: true })).json().ticketToken, a.json().ticketToken); // idempotent, no second guest
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM guest WHERE name = 'Persona Nueva'").get().n, 1);
  assert.equal((await post(`/api/admin/verifications/${v.id}/reject`)).statusCode, 409);
});
