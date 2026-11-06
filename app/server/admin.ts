import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { newToken } from './lib.ts';
import { nameTokens, dniDigits, normEmail } from '../src/shared/identity.js';
import { gameById } from '../src/shared/games.js';
import type { State } from './state.ts';

const normalize = (s: string) => nameTokens(s).join(' ');
const SESSION_MS = 86_400_000;
const ONLINE_MS = 15_000;
const sha = (s: string) => createHash('sha256').update(s).digest();
const csvField = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // formula injection: neutralize strings only (numbers are never prefixed)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) return csvField("'" + s);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');

export function registerAdmin(app: FastifyInstance, db: DatabaseSync, state: State, adminPassword: string) {
  const loginHits = new Map<string, number[]>(); // ip -> timestamps (only failures; ponytail: in memory, resets on restart)

  const cookies = (req: FastifyRequest) =>
    Object.fromEntries((req.headers.cookie ?? '').split(';').map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? ['', ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; // tokens are base64url, no decoding
    }));
  const tokenOf = (req: FastifyRequest) => cookies(req).fa as string | undefined;
  const roleOf = (req: FastifyRequest): string | undefined => {
    const t = tokenOf(req);
    if (!t) return undefined;
    const row = db.prepare("SELECT ref FROM session WHERE token = ? AND kind = 'admin' AND created_at > ?").get(t, Date.now() - SESSION_MS) as { ref: string } | undefined;
    return row?.ref;
  };
  // onRequest (not preHandler) so unauthenticated callers never get their body parsed.
  const requireRole = (...roles: string[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const role = roleOf(req);
    if (!role || !roles.includes(role)) return reply.code(401).send({ error: 'unauthorized' });
    (req as any).role = role;
  };
  const audit = (role: string, action: string, detail?: unknown) => {
    db.prepare('INSERT INTO audit_log(at, role, action, detail) VALUES (?,?,?,?)').run(Date.now(), role, action, detail === undefined ? null : JSON.stringify(detail));
  };
  const roleIn = (req: FastifyRequest) => (req as any).role as string;
  const admin = { onRequest: requireRole('admin') };

  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 1_048_576 }, (_req, body, done) => done(null, body));

  app.post('/api/admin/login', {
    schema: { body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!adminPassword) return reply.code(503).send({ error: 'admin_disabled' });
    const now = Date.now();
    const hits = (loginHits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) return reply.code(429).send({ error: 'rate_limited' });
    if (!timingSafeEqual(sha((req.body as any).password), sha(adminPassword))) {
      hits.push(now);
      loginHits.set(req.ip, hits);
      return reply.code(401).send({ error: 'wrong_password' });
    }
    loginHits.delete(req.ip);
    const token = newToken();
    db.prepare("INSERT INTO session(token, kind, ref, created_at) VALUES (?, 'admin', 'admin', ?)").run(token, now);
    audit('admin', 'login');
    reply.header('set-cookie', `fa=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
    return reply.code(204).send();
  });

  app.post('/api/admin/logout', admin, async (req, reply) => {
    db.prepare('DELETE FROM session WHERE token = ?').run(tokenOf(req));
    audit(roleIn(req), 'logout');
    reply.header('set-cookie', 'fa=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return reply.code(204).send();
  });

  app.get('/api/admin/me', admin, async (req) => ({ role: roleIn(req) }));

  app.get('/api/admin/state', admin, async () => {
    const settings = state.settings();
    const count = (col: string) => (db.prepare(`SELECT COUNT(*) AS n FROM registration WHERE ${col} IS NOT NULL`).get() as { n: number }).n;
    const won = count('prize_won_at');
    const now = Date.now();
    const screens = (db.prepare('SELECT id, game, last_seen FROM screen ORDER BY last_seen DESC LIMIT 100').all() as { id: string; game: string; last_seen: number }[])
      .map((s) => ({ id: s.id, game: s.game, lastSeen: s.last_seen, online: now - s.last_seen <= ONLINE_MS }));
    return { settings, games: state.allGames(), screens, prizes: { stock: settings.prizeStock, won, delivered: count('prize_delivered_at'), left: settings.prizeStock - won } };
  });

  app.put('/api/admin/settings', {
    ...admin,
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          paused: { type: 'boolean' }, transition: { type: 'boolean' }, transitionText: { type: 'string', maxLength: 200 },
          prizeStock: { type: 'integer', minimum: 0 }, raffleShowSeconds: { type: 'integer', minimum: 1, maximum: 600 },
          registrationValidation: { enum: ['name_only', 'name_dni_email'] },
        },
      },
    },
  }, async (req) => {
    const patch = req.body as Record<string, unknown>;
    state.tx(() => {
      for (const [k, v] of Object.entries(patch)) state.setSetting(k, v);
      audit(roleIn(req), 'settings', patch);
    });
    return state.settings();
  });

  app.put('/api/admin/games/:id', {
    ...admin,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          enabled: { type: 'boolean' }, sort: { type: 'integer', minimum: 0 }, threshold: { type: 'integer', minimum: 0, maximum: 100 },
          maxAttempts: { type: 'integer', minimum: 1 }, params: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const cur = state.gameConfig(id);
    if (!cur) return reply.code(404).send({ error: 'unknown_game' });
    const p = req.body as Record<string, any>;
    // ponytail: params replaces the stored overrides wholesale (no deep merge)
    db.prepare('UPDATE game_config SET enabled = ?, sort = ?, threshold = ?, max_attempts = ?, params = ? WHERE game = ?').run(
      (p.enabled ?? cur.enabled) ? 1 : 0, p.sort ?? cur.sort, p.threshold ?? cur.threshold, p.maxAttempts ?? cur.maxAttempts,
      JSON.stringify(p.params ?? cur.params), id);
    audit(roleIn(req), 'game', { id, ...p });
    return state.gameConfig(id);
  });

  app.get('/api/admin/guests', {
    ...admin,
    schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 60 } } } },
  }, async (req) => {
    const q = normalize(String((req.query as any).q ?? ''));
    const rows = db.prepare(
      `SELECT g.id, g.name, r.guest_id IS NOT NULL AS registered, r.checked_in_at, r.prize_won_at, r.prize_delivered_at,
         (SELECT COUNT(*) FROM attempt a WHERE a.guest_id = g.id) AS attempts
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id ORDER BY g.name`
    ).all() as any[];
    // ponytail: filter in JS for accent-insensitive match; fine for a few hundred guests
    return rows.filter((r) => !q || normalize(r.name).includes(q)).slice(0, 200).map((r) => ({
      id: r.id, name: r.name, registered: !!r.registered, checkedInAt: r.checked_in_at, prizeWonAt: r.prize_won_at,
      prizeDeliveredAt: r.prize_delivered_at, attempts: r.attempts,
    }));
  });

  app.post('/api/admin/guests/import', { ...admin, bodyLimit: 1_048_576 }, async (req, reply) => {
    if (typeof req.body !== 'string') return reply.code(415).send({ error: 'csv_required' });
    // CSV: name,dni,email ('#' lines are comments; optional header). Name may be quoted; dni/email never contain commas.
    const lines = req.body.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    const rows = lines.slice(/^"?name"?\s*(,|$)/i.test(lines[0]?.trim() ?? '') ? 1 : 0).map((line) => {
      const m = line.match(/^\s*"((?:[^"]|"")*)"\s*(?:,(.*))?$/);
      const [name, ...rest] = m ? [m[1].replace(/""/g, '"'), ...(m[2] ?? '').split(',')] : line.split(',');
      return { name: name.trim(), dni: dniDigits(rest[0]), email: normEmail(rest[1]) };
    }).filter((r) => r.name);
    const exists = db.prepare('SELECT 1 FROM guest WHERE name = ?');
    // Re-import updates dni/email but never blanks them and never deletes guests.
    const ins = db.prepare(`INSERT INTO guest(name, dni, email) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET
      dni = COALESCE(NULLIF(excluded.dni, ''), dni), email = COALESCE(NULLIF(excluded.email, ''), email)`);
    let added = 0;
    state.tx(() => {
      for (const r of rows) { if (!exists.get(r.name)) added++; ins.run(r.name, r.dni, r.email); }
      audit(roleIn(req), 'import', { rows: rows.length, added });
    });
    return { added, total: (db.prepare('SELECT COUNT(*) AS n FROM guest').get() as { n: number }).n };
  });

  app.get('/api/admin/guests/:id', admin, async (req, reply) => {
    const g = db.prepare(
      `SELECT g.id, g.name, r.checked_in_at AS checkedInAt, r.prize_won_at AS prizeWonAt, r.prize_delivered_at AS prizeDeliveredAt
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id WHERE g.id = ?`
    ).get((req.params as any).id) as any;
    if (!g) return reply.code(404).send({ error: 'not_found' });
    const attempts = db.prepare(
      'SELECT game, score, duration_ms AS durationMs, started_at AS startedAt, finished_at AS finishedAt FROM attempt WHERE guest_id = ? ORDER BY started_at'
    ).all(g.id);
    return { ...g, attempts };
  });

  app.post('/api/admin/guests/:id/checkin', admin, async (req, reply) => {
    const id = (req.params as any).id;
    if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    const reg = db.prepare('SELECT checked_in_at FROM registration WHERE guest_id = ?').get(id) as { checked_in_at: number | null } | undefined;
    if (!reg) return reply.code(409).send({ error: 'not_registered' });
    const at = reg.checked_in_at ?? Date.now(); // idempotent: keeps the first check-in time
    if (!reg.checked_in_at) {
      db.prepare('UPDATE registration SET checked_in_at = ? WHERE guest_id = ?').run(at, id);
      audit(roleIn(req), 'guest_checkin', { guestId: Number(id) });
    }
    return { checkedInAt: at };
  });

  app.post('/api/admin/checkin/:token', {
    ...admin,
    schema: { body: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { enum: ['checkin', 'deliver'] } } } },
  }, async (req, reply) => {
    const token = (req.params as any).token as string;
    const v = state.checkinView(token);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    const { action } = req.body as { action: 'checkin' | 'deliver' };
    const now = Date.now();
    if (action === 'checkin') {
      if (v.checkedInAt) return reply.code(409).send({ error: 'already_checked_in' });
      db.prepare('UPDATE registration SET checked_in_at = ? WHERE checkin_token = ?').run(now, token);
    } else {
      if (!v.prizeWonAt) return reply.code(409).send({ error: 'no_prize' });
      if (v.prizeDeliveredAt) return reply.code(409).send({ error: 'already_delivered' });
      db.prepare('UPDATE registration SET prize_delivered_at = ? WHERE checkin_token = ?').run(now, token);
    }
    audit(roleIn(req), action, { name: v.name });
    return state.checkinView(token);
  });

  app.get('/api/admin/ranking/:game', admin, async (req, reply) => {
    const game = (req.params as any).game as string;
    if (!gameById(game)) return reply.code(404).send({ error: 'unknown_game' });
    return (db.prepare(
      `SELECT name, score, duration_ms AS durationMs FROM (
         SELECT g.name, a.score, a.duration_ms,
           ROW_NUMBER() OVER (PARTITION BY a.guest_id ORDER BY a.score DESC, a.duration_ms ASC) AS rn
         FROM attempt a JOIN guest g ON g.id = a.guest_id WHERE a.game = ? AND a.finished_at IS NOT NULL)
       WHERE rn = 1 ORDER BY score DESC, durationMs ASC`
    ).all(game) as any[]).map((r) => ({ ...r }));
  });

  app.get('/api/admin/attempts.csv', admin, async (_req, reply) => {
    const rows = db.prepare(
      `SELECT g.name, a.game, a.score, a.duration_ms, a.started_at, a.finished_at
       FROM attempt a JOIN guest g ON g.id = a.guest_id ORDER BY a.started_at`
    ).all() as any[];
    const lines = ['name,game,score,duration_ms,started_at,finished_at'];
    for (const r of rows) lines.push([r.name, r.game, r.score, r.duration_ms, iso(r.started_at), iso(r.finished_at)].map(csvField).join(','));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="attempts.csv"').send(lines.join('\n') + '\n');
  });

  app.post('/api/admin/raffle', admin, async (req, reply) => {
    const pool = db.prepare(
      'SELECT guest_id FROM registration WHERE checked_in_at IS NOT NULL AND guest_id NOT IN (SELECT guest_id FROM raffle)'
    ).all() as { guest_id: number }[];
    if (!pool.length) return reply.code(409).send({ error: 'no_candidates' });
    const pick = pool[randomInt(pool.length)].guest_id;
    const drawnAt = Date.now();
    const id = state.tx(() => {
      const id = Number(db.prepare('INSERT INTO raffle(guest_id, drawn_at) VALUES (?,?)').run(pick, drawnAt).lastInsertRowid);
      state.setSetting('raffleHidden', 0);
      audit(roleIn(req), 'raffle', { id, guestId: pick });
      return id;
    });
    const { name } = db.prepare('SELECT name FROM guest WHERE id = ?').get(pick) as { name: string };
    return { id, name, drawnAt };
  });

  app.post('/api/admin/raffle/hide', admin, async (req, reply) => {
    const last = db.prepare('SELECT MAX(id) AS id FROM raffle').get() as { id: number | null };
    state.setSetting('raffleHidden', last.id ?? 0);
    audit(roleIn(req), 'raffle_hide');
    return reply.code(204).send();
  });

  return { roleOf };
}
