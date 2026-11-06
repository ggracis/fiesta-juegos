import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from './db.ts';
import { generatePin, newToken } from './lib.ts';
import { matchesName, verify, validDni, validEmail, dniDigits, normEmail } from '../src/shared/identity.js';
import { clampScore, MIN_TOTAL_MS } from '../src/shared/scoring.js';

const ROOT = join(import.meta.dirname, '..');
const DB_PATH = join(ROOT, 'data', 'fiesta.db');
const DIST = join(ROOT, 'dist');
const CSV_PATH = join(ROOT, 'data', 'guests.csv');

const MAX_FAILS = 5;
const LOCK_MS = 30_000;

export function buildApp(dbPath = DB_PATH, csvPath = CSV_PATH) {
  const db = openDb(dbPath, csvPath);
  const app = Fastify({ trustProxy: true });
  const sessions = new Map<string, number>(); // session token -> guest id
  const fails = new Map<string, { n: number; until: number }>(); // screen id -> state (all venue panels share one public IP)
  const hits = new Map<string, number[]>(); // route+ip -> timestamps
  const limited = (route: string, ip: string, max: number) => { // more than `max` requests in 10 s from one IP
    const now = Date.now(), k = route + ip;
    const h = (hits.get(k) ?? []).filter((t) => now - t < 10_000);
    h.push(now);
    hits.set(k, h);
    return h.length > max;
  };
  const roster = () => db.prepare('SELECT id, name, dni, email FROM guest').all() as { id: number; name: string; dni: string; email: string }[];

  if (existsSync(DIST)) {
    app.register(fastifyStatic, { root: DIST });
    app.get('/play', (_, reply) => reply.redirect('/play.html'));
    app.get('/diag', (_, reply) => reply.redirect('/diag.html'));
    // Compatibility with the pilot's printed/sent links
    app.get('/t/:token', (req, reply) => reply.redirect('/ticket.html?t=' + encodeURIComponent((req.params as any).token)));
    app.get('/c/:token', (req, reply) => reply.redirect('/checkin.html?c=' + encodeURIComponent((req.params as any).token)));
  }

  // Found / not found only: never echo roster data.
  app.post('/api/lookup', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 3, maxLength: 100 } } } },
  }, async (req, reply) => {
    if (limited('lookup', req.ip, 30)) return reply.code(429).send({ error: 'rate_limited' });
    return { found: roster().some((g) => matchesName(g.name, (req.body as any).name)) };
  });

  app.post('/api/register', {
    schema: { body: { type: 'object', required: ['name', 'dni', 'email'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 3, maxLength: 100 }, dni: { type: 'string', maxLength: 20 }, email: { type: 'string', maxLength: 120 } } } },
  }, async (req, reply) => {
    if (limited('register', req.ip, 10)) return reply.code(429).send({ error: 'rate_limited' });
    const { name, dni, email } = req.body as { name: string; dni: string; email: string };
    if (!validDni(dni) || !validEmail(email)) return reply.code(400).send({ error: 'invalid_input' });
    const r = verify(roster().filter((g) => matchesName(g.name, name)), { dni, email });
    if (!r.guest) {
      db.prepare('INSERT INTO verification_request(name, dni, email, candidates, created_at) VALUES (?,?,?,?,?)')
        .run(name.trim(), dniDigits(dni), normEmail(email), JSON.stringify(r.pending), Date.now());
      return { status: 'pending' };
    }
    // Already registered with matching data: hand back the existing ticket (lost-ticket recovery).
    const done = db.prepare('SELECT ticket_token FROM registration WHERE guest_id = ?').get(r.guest.id) as { ticket_token: string } | undefined;
    if (done) return { status: 'registered', ticketToken: done.ticket_token };
    const taken = db.prepare('SELECT 1 FROM registration WHERE pin = ?');
    const pin = generatePin((p) => !!taken.get(p));
    const ticket = newToken();
    db.prepare('INSERT INTO registration(guest_id, pin, ticket_token, checkin_token, created_at) VALUES (?,?,?,?,?)')
      .run(r.guest.id, pin, ticket, newToken(), Date.now());
    return { status: 'registered', ticketToken: ticket };
  });

  app.get('/api/ticket/:token', async (req, reply) => {
    const row = db.prepare(
      'SELECT g.name, r.pin, r.checkin_token FROM registration r JOIN guest g ON g.id = r.guest_id WHERE r.ticket_token = ?'
    ).get((req.params as any).token) as { name: string; pin: string; checkin_token: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { name: row.name, pin: row.pin, checkinToken: row.checkin_token };
  });

  app.post('/api/login', {
    schema: { body: { type: 'object', required: ['pin', 'screenId'], additionalProperties: false, properties: { pin: { type: 'string', pattern: '^[0-9]{6}$' }, screenId: { type: 'string', minLength: 8, maxLength: 64 } } } },
  }, async (req, reply) => {
    const now = Date.now();
    const { screenId } = req.body as { screenId: string };
    const f = fails.get(screenId) ?? { n: 0, until: 0 };
    if (f.until > now) return reply.code(429).send({ error: 'locked', retryAfter: Math.ceil((f.until - now) / 1000) });
    const row = db.prepare(
      'SELECT g.id, g.name FROM registration r JOIN guest g ON g.id = r.guest_id WHERE r.pin = ?'
    ).get((req.body as any).pin) as { id: number; name: string } | undefined;
    if (!row) {
      f.n++;
      if (f.n >= MAX_FAILS) { f.n = 0; f.until = now + LOCK_MS; }
      fails.set(screenId, f);
      const locked = f.until > now;
      return reply.code(401).send({ error: 'wrong_pin', remaining: locked ? 0 : MAX_FAILS - f.n, locked, retryAfter: locked ? LOCK_MS / 1000 : 0 });
    }
    fails.delete(screenId);
    const session = newToken();
    sessions.set(session, row.id);
    return { name: row.name, session };
  });

  app.post('/api/attempts', {
    schema: { body: { type: 'object', required: ['session'], additionalProperties: false, properties: { session: { type: 'string' } } } },
  }, async (req, reply) => {
    const guestId = sessions.get((req.body as any).session);
    if (!guestId) return reply.code(401).send({ error: 'bad_session' });
    const id = randomUUID();
    const seed = randomInt(1, 2 ** 31);
    const serverStart = Date.now();
    db.prepare('INSERT INTO attempt(id, guest_id, seed, started_at) VALUES (?,?,?,?)').run(id, guestId, seed, serverStart);
    return { attemptId: id, seed, serverStart };
  });

  app.post('/api/attempts/:id/result', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['score', 'durationMs'], additionalProperties: false, properties: { score: { type: 'number' }, durationMs: { type: 'number' } } },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id;
    const a = db.prepare('SELECT started_at, finished_at, score FROM attempt WHERE id = ?').get(id) as any;
    if (!a) return reply.code(404).send({ error: 'unknown_attempt' });
    if (a.finished_at) return { score: a.score, replay: true };
    const { score, durationMs } = req.body as { score: number; durationMs: number };
    const now = Date.now();
    if (durationMs < MIN_TOTAL_MS || now - a.started_at < MIN_TOTAL_MS) return reply.code(400).send({ error: 'implausible_duration' });
    const final = clampScore(score);
    db.prepare('UPDATE attempt SET finished_at = ?, score = ?, duration_ms = ? WHERE id = ? AND finished_at IS NULL')
      .run(now, final, Math.round(durationMs), id);
    return { score: final, replay: false };
  });

  return app;
}

if (import.meta.main) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
}
