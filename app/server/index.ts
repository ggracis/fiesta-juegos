import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from './db.ts';
import { generatePin, newToken, normalize } from './lib.ts';
import { clampScore, MIN_TOTAL_MS } from '../src/shared/scoring.js';

const ROOT = join(import.meta.dirname, '..');
const DB_PATH = join(ROOT, 'data', 'fiesta.db');
const DIST = join(ROOT, 'dist');
const CSV_PATH = join(ROOT, 'data', 'guests.csv');

const MAX_FAILS = 5;
const LOCK_MS = 30_000;

export function buildApp(dbPath = DB_PATH) {
  const db = openDb(dbPath, CSV_PATH);
  const app = Fastify({ trustProxy: true });
  const sessions = new Map<string, number>(); // session token -> guest id
  const fails = new Map<string, { n: number; until: number }>(); // screen id -> state (all venue panels share one public IP)
  const searchHits = new Map<string, number[]>(); // ip -> timestamps

  if (existsSync(DIST)) {
    app.register(fastifyStatic, { root: DIST });
    app.get('/play', (_, reply) => reply.redirect('/play.html'));
    app.get('/diag', (_, reply) => reply.redirect('/diag.html'));
    // Compatibility with the pilot's printed/sent links
    app.get('/t/:token', (req, reply) => reply.redirect('/ticket.html?t=' + encodeURIComponent((req.params as any).token)));
    app.get('/c/:token', (req, reply) => reply.redirect('/checkin.html?c=' + encodeURIComponent((req.params as any).token)));
  }

  app.get('/api/guests/search', {
    schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 3, maxLength: 60 } } } },
  }, async (req, reply) => {
    const now = Date.now();
    const hits = (searchHits.get(req.ip) ?? []).filter((t) => now - t < 10_000);
    hits.push(now);
    searchHits.set(req.ip, hits);
    if (hits.length > 30) return reply.code(429).send({ error: 'rate_limited' });

    const q = normalize((req.query as any).q);
    if (q.length < 3) return reply.code(400).send({ error: 'query_too_short' });
    const rows = db.prepare(
      'SELECT g.id, g.name, r.guest_id IS NOT NULL AS registered FROM guest g LEFT JOIN registration r ON r.guest_id = g.id ORDER BY g.name'
    ).all() as { id: number; name: string; registered: number }[];
    return rows.filter((r) => normalize(r.name).includes(q)).slice(0, 5)
      .map((r) => ({ id: r.id, name: r.name, registered: !!r.registered }));
  });

  app.post('/api/register', {
    schema: { body: { type: 'object', required: ['guestId'], additionalProperties: false, properties: { guestId: { type: 'integer' } } } },
  }, async (req, reply) => {
    const { guestId } = req.body as { guestId: number };
    if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(guestId)) return reply.code(404).send({ error: 'unknown_guest' });
    if (db.prepare('SELECT 1 FROM registration WHERE guest_id = ?').get(guestId)) {
      return reply.code(409).send({ error: 'already_registered', message: 'Este nombre ya está inscrito. Si eres tú, avisa a la organización.' });
    }
    const taken = db.prepare('SELECT 1 FROM registration WHERE pin = ?');
    const pin = generatePin((p) => !!taken.get(p));
    const ticket = newToken();
    db.prepare('INSERT INTO registration(guest_id, pin, ticket_token, checkin_token, created_at) VALUES (?,?,?,?,?)')
      .run(guestId, pin, ticket, newToken(), Date.now());
    return { ticketToken: ticket };
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
