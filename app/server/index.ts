import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from './db.ts';
import { makeState } from './state.ts';
import { registerAdmin } from './admin.ts';
import { generatePin, newToken, normalize } from './lib.ts';
import { clampScore, MIN_TOTAL_MS } from '../src/shared/scoring.js';

const ROOT = join(import.meta.dirname, '..');
const DB_PATH = join(ROOT, 'data', 'fiesta.db');
const DIST = join(ROOT, 'dist');
const CSV_PATH = join(ROOT, 'data', 'guests.csv');

const MAX_FAILS = 5;
const LOCK_MS = 30_000;

export function buildApp(dbPath = DB_PATH, opts: { adminPassword?: string } = {}) {
  const db = openDb(dbPath, CSV_PATH);
  // removeAdditional off: unknown body keys must be rejected (400), not silently stripped
  const app = Fastify({ trustProxy: true, ajv: { customOptions: { removeAdditional: false } } });
  app.decorate('db', db);
  app.addHook('onClose', () => { db.close(); });
  const state = makeState(db);
  const { roleOf } = registerAdmin(app, db, state, opts.adminPassword ?? process.env.ADMIN_PASSWORD ?? '');
  const guestOf = (session: unknown) => {
    const row = db.prepare("SELECT ref FROM session WHERE token = ? AND kind = 'guest'").get(String(session)) as { ref: string } | undefined;
    return row ? Number(row.ref) : undefined;
  };
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
    db.prepare("INSERT INTO session(token, kind, ref, created_at) VALUES (?, 'guest', ?, ?)").run(session, String(row.id), now);
    return { name: row.name, session };
  });

  app.post('/api/attempts', {
    schema: { body: { type: 'object', required: ['session', 'game'], additionalProperties: false, properties: { session: { type: 'string' }, game: { type: 'string' } } } },
  }, async (req, reply) => {
    const { session, game } = req.body as { session: string; game: string };
    const guestId = guestOf(session);
    if (!guestId) return reply.code(401).send({ error: 'bad_session' });
    const cfg = state.gameConfig(game);
    if (!cfg) return reply.code(400).send({ error: 'unknown_game' });
    if (!cfg.ready || !cfg.enabled || state.settings().paused) return reply.code(409).send({ error: 'game_unavailable' });
    // no await between the count and the insert below: sync sqlite makes this race-free
    // counts unfinished attempts too, so abandoning a game doesn't grant a retry
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM attempt WHERE guest_id = ? AND game = ?').get(guestId, game) as { n: number };
    if (n >= cfg.maxAttempts) return reply.code(409).send({ error: 'max_attempts' });
    const id = randomUUID();
    const seed = randomInt(1, 2 ** 31);
    const serverStart = Date.now();
    db.prepare('INSERT INTO attempt(id, guest_id, game, seed, started_at) VALUES (?,?,?,?,?)').run(id, guestId, game, seed, serverStart);
    return { attemptId: id, seed, serverStart };
  });

  app.post('/api/attempts/:id/result', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['score', 'durationMs'], additionalProperties: false, properties: { score: { type: 'number' }, durationMs: { type: 'number' } } },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id;
    const a = db.prepare('SELECT guest_id, game, started_at, finished_at, score FROM attempt WHERE id = ?').get(id) as any;
    if (!a) return reply.code(404).send({ error: 'unknown_attempt' });
    if (a.finished_at) return { score: a.score, replay: true, prizeWon: false };
    const { score, durationMs } = req.body as { score: number; durationMs: number };
    const now = Date.now();
    if (durationMs < MIN_TOTAL_MS || now - a.started_at < MIN_TOTAL_MS) return reply.code(400).send({ error: 'implausible_duration' });
    const final = clampScore(score);
    const prizeWon = state.tx(() => {
      let won = false;
      db.prepare('UPDATE attempt SET finished_at = ?, score = ?, duration_ms = ? WHERE id = ? AND finished_at IS NULL')
        .run(now, final, Math.round(durationMs), id);
      if (final >= (state.gameConfig(a.game)?.threshold ?? Infinity)) {
        // one statement: guest has no prize yet AND stock left, so stock can't go negative
        won = db.prepare(
          'UPDATE registration SET prize_won_at = ? WHERE guest_id = ? AND prize_won_at IS NULL AND (SELECT COUNT(*) FROM registration WHERE prize_won_at IS NOT NULL) < ?'
        ).run(now, a.guest_id, state.settings().prizeStock).changes === 1;
      }
      return won;
    });
    return { score: final, replay: false, prizeWon };
  });

  app.get('/api/live', async (req) => {
    const q = req.query as { screenId?: string; game?: string; session?: string };
    const now = Date.now();
    if (typeof q.screenId === 'string' && q.screenId.length >= 8 && q.screenId.length <= 64) {
      const game = typeof q.game === 'string' && q.game ? q.game.slice(0, 32) : 'menu';
      db.prepare('DELETE FROM screen WHERE last_seen < ?').run(now - 3600_000);
      db.prepare('INSERT INTO screen(id, last_seen, game) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, game = excluded.game').run(q.screenId, now, game);
    }
    const settings = state.settings();
    const guestId = q.session ? guestOf(q.session) : undefined;
    const count = db.prepare('SELECT COUNT(*) AS n FROM attempt WHERE guest_id = ? AND game = ?');
    const games = state.allGames().filter((g) => g!.ready && g!.enabled).map((g) => ({
      id: g!.id, name: g!.name, params: g!.params,
      ...(guestId ? { attemptsLeft: Math.max(0, g!.maxAttempts - (count.get(guestId, g!.id) as { n: number }).n) } : {}),
    }));
    const r = db.prepare('SELECT r.id, g.name, r.drawn_at FROM raffle r JOIN guest g ON g.id = r.guest_id ORDER BY r.id DESC LIMIT 1').get() as { id: number; name: string; drawn_at: number } | undefined;
    const raffle = r && state.getSetting('raffleHidden') !== r.id ? { id: r.id, name: r.name, drawnAt: r.drawn_at, showSeconds: settings.raffleShowSeconds } : null;
    return { paused: settings.paused, transition: { on: settings.transition, text: settings.transitionText }, games, raffle };
  });

  app.get('/api/checkin/:token', async (req, reply) => {
    const v = state.checkinView((req.params as any).token);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    return roleOf(req) ? v : { name: v.name };
  });

  return app;
}

if (import.meta.main) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
}
