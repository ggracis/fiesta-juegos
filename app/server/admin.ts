import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newToken, csvLine, PIXEL_DIR, createRegistration } from './lib.ts';
import { nameTokens, dniDigits, normEmail } from '../src/shared/identity.js';
import { gameById, PARAM_INFO } from '../src/shared/games.js';
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
const shuffle = <T>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Door-mode filter chips on the guest list ("Sin acreditar" = anyone not checked in yet).
const FILTERS = {
  all: () => true,
  unaccredited: (r: any) => !r.checked_in_at,
  accredited: (r: any) => !!r.checked_in_at,
  unconfirmed: (r: any) => !r.registered,
  walkIn: (r: any) => !!r.walk_in,
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
    const pendingVerifications = (db.prepare("SELECT COUNT(*) AS n FROM verification_request WHERE status = 'pending'").get() as { n: number }).n;
    return { settings, games: state.allGames(), screens, pendingVerifications, prizes: { stock: settings.prizeStock, won, delivered: count('prize_delivered_at'), left: settings.prizeStock - won } };
  });

  app.put('/api/admin/settings', {
    ...admin,
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          paused: { type: 'boolean' }, transition: { type: 'boolean' }, transitionText: { type: 'string', maxLength: 200 },
          prizeStock: { type: 'integer', minimum: 0 }, raffleShowSeconds: { type: 'integer', minimum: 1, maximum: 600 },
          raffleMode: { type: 'boolean' },
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
          maxAttempts: { type: 'integer', minimum: 1 }, params: { type: 'object', maxProperties: 20, additionalProperties: { type: 'number' } },
        },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const cur = state.gameConfig(id);
    if (!cur) return reply.code(404).send({ error: 'unknown_game' });
    const p = req.body as Record<string, any>;
    // Known keys must stay inside the bounds the admin UI shows (PARAM_INFO); unknown keys pass through as before.
    const out = Object.entries(p.params ?? {}).find(([k, v]) => { const i = (PARAM_INFO as any)[k]; return i && ((v as number) < i.min || (v as number) > i.max); });
    if (out) return reply.code(400).send({ error: 'out_of_range', param: out[0] });
    // ponytail: params replaces the stored overrides wholesale (no deep merge)
    db.prepare('UPDATE game_config SET enabled = ?, sort = ?, threshold = ?, max_attempts = ?, params = ? WHERE game = ?').run(
      (p.enabled ?? cur.enabled) ? 1 : 0, p.sort ?? cur.sort, p.threshold ?? cur.threshold, p.maxAttempts ?? cur.maxAttempts,
      JSON.stringify(p.params ?? cur.params), id);
    audit(roleIn(req), 'game', { id, ...p });
    return state.gameConfig(id);
  });

  app.get('/api/admin/guests', {
    ...admin,
    schema: { querystring: { type: 'object', properties: {
      q: { type: 'string', maxLength: 60 }, filter: { enum: ['all', 'unaccredited', 'accredited', 'unconfirmed', 'walkIn'] } } } },
  }, async (req) => {
    const { q: rawQ = '', filter = 'all' } = req.query as { q?: string; filter?: keyof typeof FILTERS };
    const q = normalize(rawQ), digits = dniDigits(rawQ), mail = normEmail(rawQ);
    const rows = db.prepare(
      `SELECT g.id, g.name, g.dni, g.email, g.walk_in, r.guest_id IS NOT NULL AS registered, r.pin, r.ticket_token, r.checked_in_at, r.prize_won_at, r.prize_delivered_at, r.dietary,
         (SELECT COUNT(*) FROM attempt a WHERE a.guest_id = g.id) AS attempts
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id`
    ).all() as any[];
    const pending = new Set((db.prepare("SELECT candidates FROM verification_request WHERE status = 'pending'").all() as { candidates: string }[])
      .flatMap((v) => JSON.parse(v.candidates) as number[]));
    // ponytail: filter in JS for accent-insensitive match; fine for a few hundred guests.
    // Name tokens, or DNI digits (dots ignored, 3+ digits), or email substring.
    const hit = (r: any) => !rawQ.trim() || normalize(r.name).includes(q)
      || (digits.length >= 3 && dniDigits(r.dni).includes(digits)) || (mail.length >= 3 && normEmail(r.email).includes(mail));
    const found = rows.filter(hit);
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, found.filter(f).length]));
    const guests = found.filter(FILTERS[filter]).sort((a, b) => a.name.localeCompare(b.name, 'es')).slice(0, 300).map((r) => ({
      id: r.id, name: r.name, dni: r.dni, walkIn: !!r.walk_in, registered: !!r.registered, checkedInAt: r.checked_in_at, prizeWonAt: r.prize_won_at,
      prizeDeliveredAt: r.prize_delivered_at, dietary: r.dietary, attempts: r.attempts, pendingVerification: pending.has(r.id),
      // Staff read the PIN straight off the card at the door (admin cookie only; public endpoints never carry it).
      pin: r.pin ?? null, ticketToken: r.ticket_token ?? null,
    }));
    const summary = { total: rows.length, confirmed: rows.filter((r) => r.registered).length, accredited: rows.filter((r) => r.checked_in_at).length };
    return { guests, counts, summary };
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
      `SELECT g.id, g.name, r.guest_id IS NOT NULL AS registered, r.pin, r.checked_in_at AS checkedInAt, r.prize_won_at AS prizeWonAt, r.prize_delivered_at AS prizeDeliveredAt, r.dietary
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id WHERE g.id = ?`
    ).get((req.params as any).id) as any;
    if (!g) return reply.code(404).send({ error: 'not_found' });
    const attempts = db.prepare(
      'SELECT game, score, duration_ms AS durationMs, started_at AS startedAt, finished_at AS finishedAt FROM attempt WHERE guest_id = ? ORDER BY started_at'
    ).all(g.id);
    return { ...g, attempts };
  });

  // Registrations the roster could not match on their own: staff confirm identity at the door and pick the guest.
  app.get('/api/admin/verifications', {
    ...admin,
    schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } } },
  }, async (req) => {
    const rows = db.prepare('SELECT * FROM verification_request WHERE status = ? ORDER BY created_at').all(String((req.query as any).status ?? 'pending')) as any[];
    const cand = db.prepare('SELECT g.id, g.name, g.dni, g.email, r.guest_id IS NOT NULL AS registered FROM guest g LEFT JOIN registration r ON r.guest_id = g.id WHERE g.id = ?');
    return rows.map((v) => ({
      id: v.id, name: v.name, dni: v.dni, email: v.email, dietary: v.dietary, createdAt: v.created_at, status: v.status,
      resolvedGuestId: v.resolved_guest_id, resolvedAt: v.resolved_at,
      candidates: (JSON.parse(v.candidates) as number[]).map((id) => cand.get(id) as any).filter(Boolean)
        .map((g) => ({ id: g.id, name: g.name, dni: g.dni, email: g.email, registered: !!g.registered })),
    }));
  });

  const pinOf = (guestId: number) => (db.prepare('SELECT pin FROM registration WHERE guest_id = ?').get(guestId) as { pin: string }).pin;
  const verification = (id: unknown) => db.prepare('SELECT status, resolved_guest_id, dietary FROM verification_request WHERE id = ?').get(id as number) as
    { status: string; resolved_guest_id: number | null; dietary: string | null } | undefined;

  app.post('/api/admin/verifications/:id/approve', {
    ...admin,
    schema: { body: { type: 'object', required: ['guestId'], additionalProperties: false, properties: { guestId: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const { guestId } = req.body as { guestId: number };
    return state.tx(() => {
      const v = verification(id);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      // Approving twice with the same guest is a no-op that hands back the same ticket.
      if (v.status !== 'pending' && !(v.status === 'approved' && v.resolved_guest_id === guestId)) return reply.code(409).send({ error: 'already_resolved' });
      if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(guestId)) return reply.code(404).send({ error: 'not_found' });
      const reg = db.prepare('SELECT ticket_token FROM registration WHERE guest_id = ?').get(guestId) as { ticket_token: string } | undefined;
      const ticketToken = reg?.ticket_token ?? createRegistration(db, guestId, v.dietary);
      if (v.status === 'pending') {
        if (reg && v.dietary) db.prepare('UPDATE registration SET dietary = ? WHERE guest_id = ?').run(v.dietary, guestId);
        db.prepare("UPDATE verification_request SET status = 'approved', resolved_guest_id = ?, resolved_at = ?, resolved_by = ? WHERE id = ?")
          .run(guestId, Date.now(), roleIn(req), id);
        audit(roleIn(req), 'verification_approve', { id, guestId });
      }
      return { ticketToken, pin: pinOf(guestId) };
    });
  });

  app.post('/api/admin/verifications/:id/reject', admin, async (req, reply) => {
    const id = Number((req.params as any).id);
    return state.tx(() => {
      const v = verification(id);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      if (v.status === 'approved') return reply.code(409).send({ error: 'already_resolved' });
      if (v.status === 'pending') {
        db.prepare("UPDATE verification_request SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ?").run(Date.now(), roleIn(req), id);
        audit(roleIn(req), 'verification_reject', { id });
      }
      return { status: 'rejected' };
    });
  });

  // Walk-ins: a guest who never confirmed gets a registration and check-in in one step; returns the ticket for the staff phone.
  const walkIn = (guestId: number, role: string, detail: Record<string, unknown>) => {
    const reg = db.prepare('SELECT ticket_token FROM registration WHERE guest_id = ?').get(guestId) as { ticket_token: string } | undefined;
    const ticketToken = reg?.ticket_token ?? createRegistration(db, guestId, null);
    db.prepare('UPDATE registration SET checked_in_at = COALESCE(checked_in_at, ?) WHERE guest_id = ?').run(Date.now(), guestId);
    if (!reg) audit(role, 'walk_in', { guestId, ...detail });
    return { guestId, ticketToken, pin: pinOf(guestId) };
  };

  app.post('/api/admin/guests/:id/walkin', admin, async (req, reply) => {
    const id = Number((req.params as any).id);
    return state.tx(() => {
      if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
      return walkIn(id, roleIn(req), {});
    });
  });

  app.post('/api/admin/guests', {
    ...admin,
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 }, dni: { type: 'string', maxLength: 20 }, email: { type: 'string', maxLength: 120 } } } },
  }, async (req, reply) => {
    const { name: raw, dni, email } = req.body as { name: string; dni?: string; email?: string };
    const name = raw.replace(/\s+/g, ' ').trim();
    if (nameTokens(name).length < 1) return reply.code(400).send({ error: 'invalid_input' });
    return state.tx(() => {
      if (db.prepare('SELECT 1 FROM guest WHERE name = ?').get(name)) return reply.code(409).send({ error: 'guest_exists' });
      const id = Number(db.prepare('INSERT INTO guest(name, dni, email, walk_in) VALUES (?,?,?,1)').run(name, dniDigits(dni), normEmail(email)).lastInsertRowid);
      return walkIn(id, roleIn(req), { added: name });
    });
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

  // ---- Quiz / pixel content (CSV). Bad rows are reported, good rows still import.
  const csvRows = (body: string, first: string) => {
    const rows = body.replace(/^\uFEFF/, '').split(/\r?\n/).map((l, i) => ({ line: i + 1, text: l.trim() }))
      .filter((r) => r.text && !r.text.startsWith('#')).map((r) => ({ line: r.line, cells: csvLine(r.text) }));
    return rows[0]?.cells[0].toLowerCase() === first ? rows.slice(1) : rows;
  };
  const importCsv = (kind: 'quiz' | 'pixel') => async (req: FastifyRequest, reply: FastifyReply) => {
    if (typeof req.body !== 'string') return reply.code(415).send({ error: 'csv_required' });
    const errors: { line: number; error: string }[] = [];
    let added = 0, updated = 0;
    const upsert = kind === 'quiz'
      ? db.prepare(`INSERT INTO quiz_question(question, correct, wrong1, wrong2, wrong3, category) VALUES (?,?,?,?,?,?) ON CONFLICT(question) DO UPDATE SET
          correct = excluded.correct, wrong1 = excluded.wrong1, wrong2 = excluded.wrong2, wrong3 = excluded.wrong3, category = excluded.category`)
      : db.prepare('INSERT INTO pixel_image(file, label, grp) VALUES (?,?,?) ON CONFLICT(file) DO UPDATE SET label = excluded.label, grp = excluded.grp');
    const exists = db.prepare(kind === 'quiz' ? 'SELECT 1 FROM quiz_question WHERE question = ?' : 'SELECT 1 FROM pixel_image WHERE file = ?');
    state.tx(() => {
      for (const { line, cells } of csvRows(req.body as string, kind === 'quiz' ? 'question' : 'file')) {
        let err = '';
        if (kind === 'quiz') {
          const [q = '', ...ans] = cells;
          const a = ans.slice(0, 4);
          if (a.length < 4 || !q || a.some((x) => !x)) err = 'empty_field';
          else if (q.length > 110) err = 'question_too_long';
          else if (a.some((x) => x.length > 40)) err = 'answer_too_long';
          else if (new Set(a).size < 4) err = 'duplicate_answers';
        } else {
          const [file = '', label = ''] = cells;
          if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(file)) err = 'invalid_file';
          else if (!label || label.length > 40) err = 'invalid_label';
          else if (!existsSync(join(PIXEL_DIR, file))) err = 'missing_file';
        }
        if (err) { errors.push({ line, error: err }); continue; }
        if (exists.get(cells[0])) updated++; else added++;
        if (kind === 'quiz') upsert.run(cells[0], cells[1], cells[2], cells[3], cells[4], cells[5] ?? '');
        else upsert.run(cells[0], cells[1], cells[2] ?? '');
      }
      audit(roleIn(req), 'content_import', { kind, added, updated, errors: errors.length });
    });
    return { added, updated, errors };
  };
  app.post('/api/admin/content/quiz/import', { ...admin, bodyLimit: 1_048_576 }, importCsv('quiz'));
  app.post('/api/admin/content/pixel/import', { ...admin, bodyLimit: 1_048_576 }, importCsv('pixel'));

  const KINDS: Record<string, { table: string; list: string }> = {
    quiz: { table: 'quiz_question', list: 'SELECT id, question, correct, wrong1, wrong2, wrong3, category FROM quiz_question ORDER BY id' },
    pixel: { table: 'pixel_image', list: 'SELECT id, file, label, grp AS "group" FROM pixel_image ORDER BY id' },
  };
  app.get('/api/admin/content/:kind', admin, async (req, reply) => {
    const k = KINDS[(req.params as any).kind];
    return k ? db.prepare(k.list).all().map((r) => ({ ...r })) : reply.code(404).send({ error: 'not_found' });
  });
  app.delete('/api/admin/content/:kind/:id', admin, async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const k = KINDS[kind];
    if (!k || db.prepare(`DELETE FROM ${k.table} WHERE id = ?`).run(id).changes === 0) return reply.code(404).send({ error: 'not_found' });
    audit(roleIn(req), 'content_delete', { kind, id: Number(id) });
    return reply.code(204).send();
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
      `SELECT g.name, a.game, a.score, a.duration_ms, a.started_at, a.finished_at, r.dietary
       FROM attempt a JOIN guest g ON g.id = a.guest_id LEFT JOIN registration r ON r.guest_id = g.id ORDER BY a.started_at`
    ).all() as any[];
    const lines = ['name,game,score,duration_ms,started_at,finished_at,dietary'];
    for (const r of rows) lines.push([r.name, r.game, r.score, r.duration_ms, iso(r.started_at), iso(r.finished_at), r.dietary].map(csvField).join(','));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="attempts.csv"').send(lines.join('\n') + '\n');
  });

  app.post('/api/admin/raffle', admin, async (req, reply) => {
    const pool = db.prepare(
      'SELECT guest_id FROM registration WHERE checked_in_at IS NOT NULL AND guest_id NOT IN (SELECT guest_id FROM raffle)'
    ).all() as { guest_id: number }[];
    if (!pool.length) return reply.code(409).send({ error: 'no_candidates' });
    const pick = pool[randomInt(pool.length)].guest_id;
    const drawnAt = Date.now();
    // Up to 40 names for the panels' reel: the winner plus a random slice of the other candidates, shuffled.
    const nameOf = db.prepare('SELECT name FROM guest WHERE id = ?');
    const others = shuffle(pool.map((p) => p.guest_id).filter((g) => g !== pick)).slice(0, 39);
    const sample = shuffle([pick, ...others]).map((g) => (nameOf.get(g) as { name: string }).name);
    const id = state.tx(() => {
      const id = Number(db.prepare('INSERT INTO raffle(guest_id, drawn_at, sample) VALUES (?,?,?)').run(pick, drawnAt, JSON.stringify(sample)).lastInsertRowid);
      state.setSetting('raffleHidden', 0);
      audit(roleIn(req), 'raffle', { id, guestId: pick });
      return id;
    });
    const { name } = db.prepare('SELECT name FROM guest WHERE id = ?').get(pick) as { name: string };
    return { id, name, drawnAt };
  });

  app.get('/api/admin/raffle', admin, async () =>
    db.prepare('SELECT r.id, g.name, r.drawn_at AS drawnAt FROM raffle r JOIN guest g ON g.id = r.guest_id ORDER BY r.id').all());
  app.post('/api/admin/raffle/hide', admin, async (req, reply) => {
    const last = db.prepare('SELECT MAX(id) AS id FROM raffle').get() as { id: number | null };
    state.setSetting('raffleHidden', last.id ?? 0);
    audit(roleIn(req), 'raffle_hide');
    return reply.code(204).send();
  });

  return { roleOf };
}
