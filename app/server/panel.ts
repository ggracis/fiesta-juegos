import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ROUND_GAMES } from '../src/shared/rounds.js';
import type { State } from './state.ts';
import type { makeResults } from './results.ts';

const sha = (s: string) => createHash('sha256').update(s).digest();
const UUID = '^[0-9a-fA-F-]{36}$';

// Offline support for the venue panels: staff-only roster download and idempotent sync of offline plays.
export function registerPanel(app: FastifyInstance, db: DatabaseSync, state: State, applyResult: ReturnType<typeof makeResults>,
  roleOf: (req: FastifyRequest) => string | undefined, panelToken: string) {
  // Random per server start; the client stores it next to the hashes, so a restart never invalidates a cached roster.
  const salt = randomBytes(16).toString('hex');
  const hashPin = (pin: string) => createHash('sha256').update(salt + ':' + pin).digest('hex');

  // Staff cookie, or (notebook on the LAN, where cookies don't cross origins) the shared PANEL_TOKEN header.
  const tokenOk = (req: FastifyRequest) => {
    const t = req.headers['x-panel-token'];
    return !!panelToken && typeof t === 'string' && timingSafeEqual(sha(t), sha(panelToken));
  };
  const staff = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!roleOf(req) && !tokenOk(req)) return reply.code(401).send({ error: 'unauthorized' });
  };

  if (panelToken) { // CORS only when a token exists: panels on another origin authenticate with the header, never with cookies
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'content-type,x-panel-token')
        .header('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    });
  }

  // ponytail: a 6-digit PIN has only 10^6 values, so anyone holding this payload can brute-force the hashes in
  // milliseconds. That is why it is staff-only and kept just in the panel's localStorage (the salted hash only keeps
  // PINs out of casual view). A slow KDF would not help at 10^6 values; a longer PIN would.
  app.get('/api/panel/roster', { onRequest: staff }, async () => {
    const counts: Record<number, Record<string, number>> = {};
    for (const r of db.prepare('SELECT guest_id, game, COUNT(*) AS n FROM attempt GROUP BY guest_id, game').all() as any[]) (counts[r.guest_id] ??= {})[r.game] = r.n;
    const guests = (db.prepare('SELECT g.id, g.name, r.pin FROM registration r JOIN guest g ON g.id = r.guest_id ORDER BY g.id').all() as any[])
      .map((g) => ({ id: g.id, name: g.name, h: hashPin(g.pin), a: counts[g.id] ?? {} }));
    const games = state.allGames().filter((g) => g!.ready && g!.enabled)
      .map((g) => ({ id: g!.id, name: g!.name, params: g!.params, threshold: g!.threshold, maxAttempts: g!.maxAttempts, offline: !ROUND_GAMES.includes(g!.id) }));
    return { salt, at: Date.now(), guests, games };
  });

  // Over-max rule: an offline attempt is always recorded (the guest played), but if the guest already had >= maxAttempts
  // attempts of that game in the DB when it arrived, it is flagged no_prize and can never win. So the first maxAttempts
  // attempts to reach the server count (online or synced, in arrival order); two panels offline at once can't double-dip.
  const insertAttempt = (it: any) => {
    if (!db.prepare('SELECT 1 FROM registration WHERE guest_id = ?').get(it.guestId)) return { error: 'unknown_guest' };
    const cfg = state.gameConfig(it.game);
    if (!cfg || !cfg.ready || ROUND_GAMES.includes(it.game)) return { error: 'unknown_game' };
    if (!Number.isInteger(it.seed) || typeof it.startedAt !== 'number') return { error: 'invalid_input' };
    return state.tx(() => {
      const have = db.prepare('SELECT guest_id FROM attempt WHERE id = ?').get(it.attemptId) as { guest_id: number } | undefined;
      if (have) return have.guest_id === it.guestId ? {} : { error: 'conflict' }; // resend: nothing to do
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM attempt WHERE guest_id = ? AND game = ?').get(it.guestId, it.game) as { n: number };
      const over = n >= cfg.maxAttempts;
      db.prepare('INSERT INTO attempt(id, guest_id, game, seed, started_at, offline, no_prize) VALUES (?,?,?,?,?,1,?)')
        .run(it.attemptId, it.guestId, it.game, it.seed, Math.min(it.startedAt, Date.now()), over ? 1 : 0);
      return over ? { flagged: true } : {};
    });
  };

  app.post('/api/panel/sync', {
    onRequest: staff,
    schema: {
      body: {
        type: 'object', required: ['items'], additionalProperties: false,
        properties: {
          items: {
            type: 'array', maxItems: 100,
            items: {
              type: 'object', required: ['kind', 'attemptId'],
              properties: {
                kind: { enum: ['attempt', 'result'] }, attemptId: { type: 'string', pattern: UUID }, guestId: { type: 'integer' },
                game: { type: 'string', maxLength: 32 }, seed: { type: 'number' }, startedAt: { type: 'number' },
                score: { type: 'number' }, durationMs: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const results = (req.body as { items: any[] }).items.map((it) => {
      const base = { attemptId: it.attemptId, kind: it.kind };
      let r: any;
      if (it.kind === 'attempt') r = insertAttempt(it);
      else if (typeof it.score !== 'number' || typeof it.durationMs !== 'number') r = { error: 'invalid_input' };
      else r = applyResult(it.attemptId, it.score, it.durationMs, false);
      return r.error ? { ...base, ok: false, error: r.error } : { ...base, ok: true, ...r };
    });
    db.prepare('INSERT INTO audit_log(at, role, action, detail) VALUES (?,?,?,?)')
      .run(Date.now(), 'panel', 'panel_sync', JSON.stringify({ items: results.length, errors: results.filter((r) => !r.ok).length }));
    return { results };
  });
}
