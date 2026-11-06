import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { openDb } from './db.ts';
import { makeState } from './state.ts';
import { registerAdmin } from './admin.ts';
import { makeResults } from './results.ts';
import { registerPanel } from './panel.ts';
import { createRegistration, newToken, PIXEL_DIR } from './lib.ts';
import { matchesName, verify, validDni, validEmail, dniDigits, normEmail, cleanDietary } from '../src/shared/identity.js';
import { buildRounds, publicRounds, mulberry32, ROUND_GAMES, ROUND_POINTS } from '../src/shared/rounds.js';

const ROOT = join(import.meta.dirname, '..');
const DB_PATH = join(ROOT, 'data', 'fiesta.db');
const DIST = join(ROOT, 'dist');
const CSV_PATH = join(ROOT, 'data', 'guests.csv');

const MAX_FAILS = 5;
const LOCK_MS = 30_000;

export function buildApp(dbPath = DB_PATH, csvPath = CSV_PATH, opts: { adminPassword?: string; panelToken?: string } = {}) {
  const db = openDb(dbPath, csvPath);
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
    app.get('/admin', (_, reply) => reply.redirect('/admin.html'));
    // Compatibility with the pilot's printed/sent links
    app.get('/t/:token', (req, reply) => reply.redirect('/ticket.html?t=' + encodeURIComponent((req.params as any).token)));
    app.get('/c/:token', (req, reply) => reply.redirect('/checkin.html?c=' + encodeURIComponent((req.params as any).token)));
  }

  mkdirSync(PIXEL_DIR, { recursive: true });
  app.register(fastifyStatic, { root: PIXEL_DIR, prefix: '/content/pixel/', decorateReply: false }); // fastify-static rejects path traversal

  const validationMode = () => state.getSetting('registrationValidation') as 'name_only' | 'name_dni_email';

  // Found / not found plus the active validation mode: never echo roster data.
  app.post('/api/lookup', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 3, maxLength: 100 } } } },
  }, async (req, reply) => {
    if (limited('lookup', req.ip, 30)) return reply.code(429).send({ error: 'rate_limited' });
    return { found: roster().some((g) => matchesName(g.name, (req.body as any).name)), mode: validationMode() };
  });

  // dni/email are optional in the schema: name_dni_email mode still rejects them when missing or malformed (below).
  // dietary: the schema only bounds the body, cleanDietary() trims, collapses whitespace and caps it at 200 chars.
  app.post('/api/register', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 3, maxLength: 100 }, dni: { type: 'string', maxLength: 20 }, email: { type: 'string', maxLength: 120 },
      dietary: { type: 'string', maxLength: 1000 } } } },
  }, async (req, reply) => {
    if (limited('register', req.ip, 10)) return reply.code(429).send({ error: 'rate_limited' });
    const { name, dni, email, dietary: rawDietary } = req.body as { name: string; dni?: string; email?: string; dietary?: string };
    const dietary = cleanDietary(rawDietary);
    const mode = validationMode();
    if (mode !== 'name_only' && (!validDni(dni) || !validEmail(email))) return reply.code(400).send({ error: 'invalid_input' });
    const r = verify(roster().filter((g) => matchesName(g.name, name)), { dni, email }, mode);
    if (!r.guest) {
      db.prepare('INSERT INTO verification_request(name, dni, email, candidates, created_at, dietary) VALUES (?,?,?,?,?,?)')
        .run(name.trim(), dniDigits(dni), normEmail(email), JSON.stringify(r.pending), Date.now(), dietary);
      return { status: 'pending' };
    }
    // Already registered with matching data: hand back the existing ticket (lost-ticket recovery).
    const done = db.prepare('SELECT ticket_token FROM registration WHERE guest_id = ?').get(r.guest.id) as { ticket_token: string } | undefined;
    if (done) {
      if (dietary) db.prepare('UPDATE registration SET dietary = ? WHERE guest_id = ?').run(dietary, r.guest.id); // empty never erases
      return { status: 'registered', ticketToken: done.ticket_token };
    }
    return { status: 'registered', ticketToken: createRegistration(db, r.guest.id, dietary) };
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
    return { name: row.name, session, guestId: row.id };
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

  const applyResult = makeResults(db, state);
  app.post('/api/attempts/:id/result', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['score', 'durationMs'], additionalProperties: false, properties: { score: { type: 'number' }, durationMs: { type: 'number' } } },
    },
  }, async (req, reply) => {
    const { score, durationMs } = req.body as { score: number; durationMs: number };
    const r = applyResult((req.params as any).id, score, durationMs);
    return 'error' in r ? reply.code(r.code!).send({ error: r.error }) : r;
  });
  registerPanel(app, db, state, applyResult, roleOf, opts.panelToken ?? process.env.PANEL_TOKEN ?? '');

  // Own attempt of the session's guest, or the error reply to send.
  const ownAttempt = (id: string, session: unknown) => {
    const guestId = guestOf(session);
    if (!guestId) return { code: 401, error: 'bad_session' };
    const a = db.prepare('SELECT guest_id, game, seed, content, finished_at FROM attempt WHERE id = ?').get(id) as any;
    if (!a) return { code: 404, error: 'unknown_attempt' };
    if (a.guest_id !== guestId) return { code: 401, error: 'bad_session' };
    return { a };
  };
  const roundSeconds = (params: Record<string, any>) => Number(params.secondsPerQuestion ?? params.revealSeconds ?? 12);

  app.get('/api/attempts/:id/rounds', {
    schema: { params: { type: 'object', properties: { id: { type: 'string' } } }, querystring: { type: 'object', properties: { session: { type: 'string' } } } },
  }, async (req, reply) => {
    const r = ownAttempt((req.params as any).id, (req.query as any).session);
    if (!r.a) return reply.code(r.code!).send({ error: r.error });
    const a = r.a;
    if (!ROUND_GAMES.includes(a.game)) return reply.code(400).send({ error: 'not_a_round_game' });
    let rounds = a.content ? JSON.parse(a.content) : null;
    if (!rounds) {
      const params = state.gameConfig(a.game)!.params;
      const bank = a.game === 'quiz'
        ? (db.prepare('SELECT question, correct, wrong1, wrong2, wrong3 FROM quiz_question ORDER BY id').all() as any[])
          .map((q) => ({ question: q.question, correct: q.correct, wrong: [q.wrong1, q.wrong2, q.wrong3] }))
        : (db.prepare('SELECT file, label, grp AS "group" FROM pixel_image ORDER BY id').all());
      try { rounds = buildRounds(a.game, bank, Number(a.game === 'quiz' ? params.questions : params.images) || (a.game === 'quiz' ? 10 : 8), mulberry32(a.seed)); }
      catch { return reply.code(409).send({ error: 'not_enough_content' }); }
      db.prepare('UPDATE attempt SET content = ? WHERE id = ?').run(JSON.stringify(rounds), (req.params as any).id);
    }
    return { rounds: publicRounds(rounds).map((x: any) => (x.image ? { ...x, image: 'content/pixel/' + x.image } : x)) };
  });

  app.post('/api/attempts/:id/answer', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['session', 'index', 'choice', 'ms'], additionalProperties: false, properties: {
        session: { type: 'string' }, index: { type: 'integer' }, choice: { type: ['integer', 'null'], minimum: 0, maximum: 3 }, ms: { type: 'number' } } },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const { session, index, choice, ms } = req.body as { session: string; index: number; choice: number | null; ms: number };
    const r = ownAttempt(id, session);
    if (!r.a) return reply.code(r.code!).send({ error: r.error });
    const a = r.a;
    if (!ROUND_GAMES.includes(a.game)) return reply.code(400).send({ error: 'not_a_round_game' });
    if (a.finished_at) return reply.code(409).send({ error: 'finished' });
    const rounds = a.content ? JSON.parse(a.content) : [];
    if (index < 0 || index >= rounds.length) return reply.code(400).send({ error: 'bad_index' });
    // sync sqlite: no await between this check and the insert
    if (db.prepare('SELECT 1 FROM answer WHERE attempt_id = ? AND idx = ?').get(id, index)) return reply.code(409).send({ error: 'already_answered' });
    const params = state.gameConfig(a.game)!.params;
    const clamped = Math.max(0, Math.min(roundSeconds(params) * 1000, Math.round(ms)));
    const correctChoice = rounds[index].answer as number;
    const correct = choice === correctChoice;
    const points = correct ? (ROUND_POINTS[a.game]?.(true, clamped, params) ?? 0) : 0; // no formula registered yet: 0
    db.prepare('INSERT INTO answer(attempt_id, idx, choice, ms, points) VALUES (?,?,?,?,?)').run(id, index, choice, clamped, points);
    return { correct, correctChoice, points };
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
  await app.listen({ port: Number(process.env.PORT) || 3000, host: process.env.HOST || '0.0.0.0' }); // HOST=127.0.0.1 behind Caddy
}
