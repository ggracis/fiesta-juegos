import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { mailGuest } from './mail.ts';
import { newToken, csvLine, PIXEL_DIR, MEDIA_DIR, createRegistration, canonical, checkinOpen } from './lib.ts';
import { nameTokens, normEmail, guestRow, validEmail } from '../src/shared/identity.js';
import { gameById, PARAM_INFO } from '../src/shared/games.js';
import { SCENES, CUE_LEAD_MS } from '../src/shared/stage.js';
import { XLSX_MIME, readXlsx, exampleXlsx } from './xlsx.ts';
import type { State } from './state.ts';

const normalize = (s: string) => nameTokens(s).join(' ');
const SESSION_MS = 86_400_000;
const ONLINE_MS = 15_000;
const sha = (s: string) => createHash('sha256').update(s).digest();
// Quotes on ',' and ';' so one helper serves both the comma CSVs and the ';' guest export.
const csvField = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  // formula injection: neutralize strings only (numbers are never prefixed)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) return csvField("'" + s);
  return /[",;\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// Buenos Aires wall-clock time for spreadsheets: 2026-11-30 21:05.
const baFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const baTime = (ms: number | null) => (ms ? baFmt.format(ms) : '');
const NO_DIETARY = /^(no|-+|ninguna|ninguno|n\/a|none)\.?$/i;
// Door-mode filter chips on the guest list ("Sin acreditar" = anyone not checked in yet).
const FILTERS = {
  all: () => true,
  unaccredited: (r: any) => !r.checked_in_at,
  accredited: (r: any) => !!r.checked_in_at,
  revalidate: (r: any) => r.on_hold === 1,
  walkIn: (r: any) => !!r.walk_in,
  duplicates: (r: any) => !!r.dup,
};
// Same person signed up twice with another email: same name tokens in any order, ignoring the "(2)" namesake suffix.
const dupKey = (name: string) => nameTokens(name.replace(/\s*\(\d+\)$/, '')).sort().join(' ');
const MAX_XLSX = 5_242_880;
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');

export function registerAdmin(app: FastifyInstance, db: DatabaseSync, state: State, adminPassword: string, doorPassword = '') {
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
  // Reception staff (role 'door') reach only what the Puerta tab needs.
  const staff = { onRequest: requireRole('admin', 'door') };

  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 1_048_576 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(XLSX_MIME, { parseAs: 'buffer', bodyLimit: MAX_XLSX }, (_req, body, done) => done(null, body));

  app.post('/api/admin/login', {
    schema: { body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!adminPassword && !doorPassword) return reply.code(503).send({ error: 'admin_disabled' });
    const now = Date.now();
    const hits = (loginHits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) return reply.code(429).send({ error: 'rate_limited' });
    const pw = sha((req.body as any).password);
    const match = (secret: string) => !!secret && timingSafeEqual(pw, sha(secret));
    const role = match(adminPassword) ? 'admin' : match(doorPassword) ? 'door' : '';
    if (!role) {
      hits.push(now);
      loginHits.set(req.ip, hits);
      return reply.code(401).send({ error: 'wrong_password' });
    }
    loginHits.delete(req.ip);
    const token = newToken();
    db.prepare("INSERT INTO session(token, kind, ref, created_at) VALUES (?, 'admin', ?, ?)").run(token, role, now);
    audit(role, 'login');
    reply.header('set-cookie', `fa=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
    return reply.code(204).send();
  });

  app.post('/api/admin/logout', staff, async (req, reply) => {
    db.prepare('DELETE FROM session WHERE token = ?').run(tokenOf(req));
    audit(roleIn(req), 'logout');
    reply.header('set-cookie', 'fa=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return reply.code(204).send();
  });

  app.get('/api/admin/me', staff, async (req) => ({ role: roleIn(req) }));

  app.get('/api/admin/state', staff, async (req) => {
    const pendingVerifications = (db.prepare("SELECT COUNT(*) AS n FROM verification_request WHERE status = 'pending'").get() as { n: number }).n;
    if (roleIn(req) === 'door') return { pendingVerifications }; // reception only needs the badge
    const settings = state.settings();
    const count = (col: string) => (db.prepare(`SELECT COUNT(*) AS n FROM registration WHERE ${col} IS NOT NULL`).get() as { n: number }).n;
    const won = count('prize_won_at');
    const now = Date.now();
    const screens = (db.prepare('SELECT id, game, last_seen FROM screen ORDER BY last_seen DESC LIMIT 100').all() as { id: string; game: string; last_seen: number }[])
      .map((s) => ({ id: s.id, game: s.game, lastSeen: s.last_seen, online: now - s.last_seen <= ONLINE_MS }));
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
          registrationValidation: { enum: ['name_only', 'name_email', 'open', 'manual'] },
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
    ...staff,
    schema: { querystring: { type: 'object', properties: {
      q: { type: 'string', maxLength: 60 }, filter: { enum: ['all', 'unaccredited', 'accredited', 'revalidate', 'walkIn', 'duplicates'] } } } },
  }, async (req) => {
    const { q: rawQ = '', filter = 'all' } = req.query as { q?: string; filter?: keyof typeof FILTERS };
    const q = normalize(rawQ), mail = normEmail(rawQ);
    const rows = db.prepare(
      `SELECT g.id, g.name, g.email, g.walk_in, g.raffle_out, r.on_hold, r.guest_id IS NOT NULL AS registered, r.pin, r.ticket_token, r.checked_in_at, r.prize_won_at, r.prize_delivered_at, r.dietary,
         (SELECT COUNT(*) FROM attempt a WHERE a.guest_id = g.id) AS attempts
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id`
    ).all() as any[];
    const keys = new Map<string, number>();
    for (const r of rows) keys.set(dupKey(r.name), (keys.get(dupKey(r.name)) ?? 0) + 1);
    for (const r of rows) r.dup = keys.get(dupKey(r.name))! > 1;
    const pending = new Set((db.prepare("SELECT candidates FROM verification_request WHERE status = 'pending'").all() as { candidates: string }[])
      .flatMap((v) => JSON.parse(v.candidates) as number[]));
    // ponytail: filter in JS for accent-insensitive match; fine for a few hundred guests.
    // Name tokens, or email substring.
    const hit = (r: any) => !rawQ.trim() || normalize(r.name).includes(q) || (mail.length >= 3 && normEmail(r.email).includes(mail));
    const found = rows.filter(hit);
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, found.filter(f).length]));
    // New inscriptions are not guests yet: the chip counts them and opens the approval queue instead of filtering.
    counts.newInscriptions = (db.prepare("SELECT COUNT(*) AS n FROM verification_request WHERE status = 'pending' AND kind = 'new'").get() as { n: number }).n;
    const guests = found.filter(FILTERS[filter]).sort((a, b) => a.name.localeCompare(b.name, 'es')).slice(0, 300).map((r) => ({
      id: r.id, name: r.name, email: r.email, walkIn: !!r.walk_in, raffleOut: !!r.raffle_out, onHold: r.on_hold === 1, rejected: r.on_hold === 2, registered: !!r.registered, checkedInAt: r.checked_in_at, prizeWonAt: r.prize_won_at,
      prizeDeliveredAt: r.prize_delivered_at, dietary: r.dietary, attempts: r.attempts, pendingVerification: pending.has(r.id), duplicate: r.dup,
      // Staff read the PIN straight off the card at the door (admin cookie only; public endpoints never carry it).
      pin: r.pin ?? null, ticketToken: r.ticket_token ?? null,
    }));
    const summary = { total: rows.length, confirmed: rows.filter((r) => r.registered).length, accredited: rows.filter((r) => r.checked_in_at).length };
    return { guests, counts, summary, checkinOpen: checkinOpen() }; // the door screen locks "Acreditar" before event day
  });

  // Shared by CSV and XLSX. Re-import updates email but never blanks them and never deletes guests.
  const importGuests = (rows: { name: string; email: string }[], role: string) => {
    const exists = db.prepare('SELECT 1 FROM guest WHERE name = ?');
    const ins = db.prepare(`INSERT INTO guest(name, email) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET
      email = COALESCE(NULLIF(excluded.email, ''), email)`);
    let added = 0;
    state.tx(() => {
      for (const r of rows) { if (!exists.get(r.name)) added++; ins.run(r.name, r.email); }
      audit(role, 'import', { rows: rows.length, added });
    });
    return { added, total: (db.prepare('SELECT COUNT(*) AS n FROM guest').get() as { n: number }).n };
  };

  // Body: text/csv (name,email) or a raw .xlsx (A=name, B=email). Legacy name,dni,email files work too: guestRow takes the first other cell with an "@". Optional header row, empty rows skipped.
  app.post('/api/admin/guests/import', { ...staff, bodyLimit: MAX_XLSX }, async (req, reply) => {
    let rows: { name: string; email: string }[];
    if (Buffer.isBuffer(req.body)) {
      let sheet: string[][];
      try { sheet = readXlsx(req.body); } catch { return reply.code(400).send({ error: 'file_invalid' }); }
      if (/^(nombre|name)\b/i.test(sheet[0]?.[0] ?? '')) sheet.shift();
      rows = sheet.map(guestRow).filter((r) => r.name);
      if (!rows.length) return reply.code(400).send({ error: 'file_empty' });
    } else {
      if (typeof req.body !== 'string') return reply.code(415).send({ error: 'csv_required' });
      // CSV: '#' lines are comments; optional header. Name may be quoted; the other cells never contain commas.
      const lines = req.body.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
      rows = lines.slice(/^"?(name|nombre)\b/i.test(lines[0]?.trim() ?? '') ? 1 : 0).map((line) => {
        const m = line.match(/^\s*"((?:[^"]|"")*)"\s*(?:,(.*))?$/);
        return guestRow(m ? [m[1].replace(/""/g, '"'), ...(m[2] ?? '').split(',')] : line.split(','));
      }).filter((r) => r.name);
    }
    return importGuests(rows, roleIn(req));
  });

  // Whole roster for catering: ';' separated with a BOM so Spanish-locale Excel opens it in columns, accents intact.
  app.get('/api/admin/guests.csv', staff, async (_req, reply) => {
    const rows = db.prepare(
      `SELECT g.name, g.email, r.guest_id IS NOT NULL AS registered, r.created_at, r.checked_in_at, r.dietary
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id`
    ).all() as any[];
    rows.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const lines = [['Nombre', 'Email', 'Estado', 'Restricciones alimentarias', 'Inscripto el', 'Acreditado el'].join(';')];
    for (const r of rows) {
      const diet = (r.dietary ?? '').trim();
      lines.push([r.name, r.email, r.checked_in_at ? 'Acreditado' : r.registered ? 'Inscripto' : 'Sin inscribir', NO_DIETARY.test(diet) ? '' : diet,
        baTime(r.created_at), baTime(r.checked_in_at)].map(csvField).join(';'));
    }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="invitados-gala.csv"').send('﻿' + lines.join('\r\n') + '\r\n');
  });

  app.get('/api/admin/guests/example.xlsx', staff, async (_req, reply) =>
    reply.header('content-type', XLSX_MIME).header('content-disposition', 'attachment; filename="invitados-ejemplo.xlsx"').send(exampleXlsx([
      ['Nombre y apellido', 'Email'], ['Ejemplo Uno', 'ejemplo1@example.com'], ['Ejemplo Dos', 'ejemplo2@example.com']])));

  app.get('/api/admin/guests/:id', staff, async (req, reply) => {
    const g = db.prepare(
      `SELECT g.id, g.name, g.email, r.guest_id IS NOT NULL AS registered, r.pin, r.checked_in_at AS checkedInAt, r.prize_won_at AS prizeWonAt, r.prize_delivered_at AS prizeDeliveredAt, r.dietary
       FROM guest g LEFT JOIN registration r ON r.guest_id = g.id WHERE g.id = ?`
    ).get((req.params as any).id) as any;
    if (!g) return reply.code(404).send({ error: 'not_found' });
    const attempts = db.prepare(
      'SELECT game, score, duration_ms AS durationMs, started_at AS startedAt, finished_at AS finishedAt FROM attempt WHERE guest_id = ? ORDER BY started_at'
    ).all(g.id);
    return { ...g, attempts };
  });

  // Removes the extra copy of a duplicate by merging it into the guest that stays: its emailed ticket, QR and PIN keep
  // working and point at the survivor (token_alias). Only while another guest with the same name remains, and never one
  // that already played or was drawn in the raffle (scores and winners stay intact).
  app.delete('/api/admin/guests/:id', staff, async (req, reply) => {
    const id = Number((req.params as any).id);
    return state.tx(() => {
      const g = db.prepare('SELECT name, email FROM guest WHERE id = ?').get(id) as { name: string; email: string | null } | undefined;
      if (!g) return reply.code(404).send({ error: 'not_found' });
      const survivor = (db.prepare('SELECT g.id, g.name, r.guest_id IS NOT NULL AS reg FROM guest g LEFT JOIN registration r ON r.guest_id = g.id WHERE g.id <> ? ORDER BY reg DESC, g.id')
        .all(id) as { id: number; name: string; reg: number }[]).find((o) => dupKey(o.name) === dupKey(g.name));
      if (!survivor) return reply.code(409).send({ error: 'not_duplicate' });
      if (db.prepare('SELECT 1 FROM attempt WHERE guest_id = ? UNION ALL SELECT 1 FROM raffle WHERE guest_id = ?').get(id, id)) return reply.code(409).send({ error: 'guest_in_use' });
      const reg = db.prepare('SELECT pin, ticket_token, checkin_token, checked_in_at, dietary FROM registration WHERE guest_id = ?').get(id) as any;
      if (reg && !survivor.reg) db.prepare('UPDATE registration SET guest_id = ? WHERE guest_id = ?').run(survivor.id, id); // survivor never confirmed: it takes this ticket as is
      else if (reg) {
        db.prepare('INSERT INTO token_alias(pin, ticket_token, checkin_token, guest_id) VALUES (?,?,?,?)').run(reg.pin, reg.ticket_token, reg.checkin_token, survivor.id);
        db.prepare('UPDATE registration SET checked_in_at = COALESCE(checked_in_at, ?), dietary = COALESCE(dietary, ?) WHERE guest_id = ?').run(reg.checked_in_at, reg.dietary, survivor.id);
        db.prepare('DELETE FROM registration WHERE guest_id = ?').run(id);
      }
      db.prepare('UPDATE token_alias SET guest_id = ? WHERE guest_id = ?').run(survivor.id, id); // aliases it already carried follow along
      db.prepare("UPDATE session SET ref = ? WHERE kind = 'guest' AND ref = ?").run(String(survivor.id), String(id)); // a screen logged in with it stays logged in
      db.prepare('DELETE FROM guest WHERE id = ?').run(id);
      audit(roleIn(req), 'guest_delete', { guestId: id, name: g.name, email: g.email, mergedInto: survivor.id });
      return { ok: true, mergedInto: survivor.name };
    });
  });

  // Staff resend: ignores email_sent_at except for a 60 s cool-down against double taps.
  app.post('/api/admin/guests/:id/resend-email', staff, async (req, reply) => {
    const id = Number((req.params as any).id);
    const r = db.prepare('SELECT g.email, r.email_sent_at FROM guest g JOIN registration r ON r.guest_id = g.id WHERE g.id = ?').get(id) as { email: string | null; email_sent_at: number | null } | undefined;
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.email) return reply.code(400).send({ error: 'no_email' });
    if (r.email_sent_at && Date.now() - r.email_sent_at < 60_000) return reply.code(429).send({ error: 'too_soon' });
    const res = await mailGuest(db, id, { force: true });
    if (!res.ok) return reply.code(502).send({ error: 'send_failed' });
    audit(roleIn(req), 'resend_email', { guestId: id });
    return { ok: true };
  });

  // Registrations the roster could not match on their own: staff confirm identity at the door and pick the guest.
  app.get('/api/admin/verifications', {
    ...staff,
    schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } } },
  }, async (req) => {
    const rows = db.prepare('SELECT * FROM verification_request WHERE status = ? ORDER BY created_at').all(String((req.query as any).status ?? 'pending')) as any[];
    const cand = db.prepare('SELECT g.id, g.name, g.email, r.guest_id IS NOT NULL AS registered FROM guest g LEFT JOIN registration r ON r.guest_id = g.id WHERE g.id = ?');
    return rows.map((v) => ({
      id: v.id, name: v.name, email: v.email, dietary: v.dietary, createdAt: v.created_at, status: v.status, kind: v.kind,
      resolvedGuestId: v.resolved_guest_id, resolvedAt: v.resolved_at,
      candidates: (JSON.parse(v.candidates) as number[]).map((id) => cand.get(id) as any).filter(Boolean)
        .map((g) => ({ id: g.id, name: g.name, email: g.email, registered: !!g.registered })),
    }));
  });

  const pinOf = (guestId: number) => (db.prepare('SELECT pin FROM registration WHERE guest_id = ?').get(guestId) as { pin: string }).pin;
  const verification = (id: unknown) => db.prepare('SELECT name, email, status, resolved_guest_id, dietary, kind, candidates FROM verification_request WHERE id = ?').get(id as number) as
    { name: string; email: string; status: string; resolved_guest_id: number | null; dietary: string | null; kind: string; candidates: string } | undefined;

  // Body: { guestId } picks a roster guest; { add: true } creates the guest from the request's name and email (no roster match), then approves.
  app.post('/api/admin/verifications/:id/approve', {
    ...staff,
    schema: { body: { type: 'object', additionalProperties: false, properties: { guestId: { type: 'integer', minimum: 1 }, add: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const id = Number((req.params as any).id);
    const { guestId: picked, add } = req.body as { guestId?: number; add?: boolean };
    if (!picked && !add) return reply.code(400).send({ error: 'invalid_input' });
    let send: { guestId: number; to: string } | undefined;
    const out = state.tx(() => {
      const v = verification(id);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      let guestId = picked as number;
      if (add) {
        if (v.status === 'approved' && v.resolved_guest_id) guestId = v.resolved_guest_id; // replay: same guest, same ticket
        else if (v.status === 'approved') return reply.code(409).send({ error: 'already_resolved' }); // pending or rejected: a rejection can be undone by approving
        else {
          const g = db.prepare('SELECT id FROM guest WHERE name = ?').get(v.name) as { id: number } | undefined; // exact name already on the list: reuse it
          guestId = g?.id ?? Number(db.prepare('INSERT INTO guest(name, email, walk_in) VALUES (?,?,1)').run(v.name, v.email).lastInsertRowid);
          if (!g) audit(roleIn(req), 'guest_add', { guestId, added: v.name, from: 'verification' });
        }
      }
      // Approving twice with the same guest is a no-op that hands back the same ticket.
      if (v.status === 'approved' && v.resolved_guest_id !== guestId) return reply.code(409).send({ error: 'already_resolved' });
      if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(guestId)) return reply.code(404).send({ error: 'not_found' });
      const reg = db.prepare('SELECT ticket_token FROM registration WHERE guest_id = ?').get(guestId) as { ticket_token: string } | undefined;
      const ticketToken = reg?.ticket_token ?? createRegistration(db, guestId, v.dietary);
      if (v.status !== 'approved') {
        if (reg && v.dietary) db.prepare('UPDATE registration SET dietary = ? WHERE guest_id = ?').run(v.dietary, guestId);
        db.prepare('UPDATE registration SET on_hold = 0 WHERE guest_id = ?').run(guestId); // revalidated: same QR and PIN work again (no new mail: email_sent_at is kept)
        db.prepare("UPDATE verification_request SET status = 'approved', resolved_guest_id = ?, resolved_at = ?, resolved_by = ? WHERE id = ?")
          .run(guestId, Date.now(), roleIn(req), id);
        audit(roleIn(req), 'verification_approve', { id, guestId });
        send = { guestId, to: v.email };
      }
      return { ticketToken, pin: pinOf(guestId) };
    });
    if (send) void mailGuest(db, send.guestId, { to: send.to }); // the request's address: unlisted guests have no roster email
    return out;
  });

  app.post('/api/admin/verifications/:id/reject', staff, async (req, reply) => {
    const id = Number((req.params as any).id);
    return state.tx(() => {
      const v = verification(id);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      if (v.status === 'approved') return reply.code(409).send({ error: 'already_resolved' });
      if (v.status === 'pending') {
        db.prepare("UPDATE verification_request SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ?").run(Date.now(), roleIn(req), id);
        if (v.kind === 'revalidate') for (const gid of JSON.parse(v.candidates) as number[]) db.prepare('UPDATE registration SET on_hold = 2 WHERE guest_id = ?').run(gid); // stays blocked, shown as rejected
        audit(roleIn(req), 'verification_reject', { id });
      }
      return { status: 'rejected' };
    });
  });

  // Walk-ins: a guest who never confirmed gets a registration and check-in in one step; returns the ticket for the staff phone.
  const walkIn = (guestId: number, role: string, detail: Record<string, unknown>) => {
    const reg = db.prepare('SELECT ticket_token FROM registration WHERE guest_id = ?').get(guestId) as { ticket_token: string } | undefined;
    const ticketToken = reg?.ticket_token ?? createRegistration(db, guestId, null);
    if (checkinOpen()) db.prepare('UPDATE registration SET checked_in_at = COALESCE(checked_in_at, ?) WHERE guest_id = ?').run(Date.now(), guestId); // before event day: confirmed and ticketed, not checked in
    if (!reg) { audit(role, 'walk_in', { guestId, ...detail }); void mailGuest(db, guestId); } // no-op without an email
    return { guestId, ticketToken, pin: pinOf(guestId), checkedIn: checkinOpen() };
  };

  // "Revalidar": the inscription goes back to staff validation. QR and PIN stop working until a verification approves it again;
  // approving keeps the same ticket and sends no new mail.
  app.post('/api/admin/guests/:id/revalidate', staff, async (req, reply) => {
    const id = Number((req.params as any).id);
    return state.tx(() => {
      const g = db.prepare('SELECT g.name, g.email, r.on_hold, r.dietary FROM guest g JOIN registration r ON r.guest_id = g.id WHERE g.id = ?').get(id) as
        { name: string; email: string | null; on_hold: number; dietary: string | null } | undefined;
      if (!g) return reply.code(409).send({ error: 'not_registered' });
      if (g.on_hold === 1) return reply.code(409).send({ error: 'already_pending' }); // a rejected one (2) can be sent back to review
      db.prepare('UPDATE registration SET on_hold = 1 WHERE guest_id = ?').run(id);
      db.prepare("UPDATE verification_request SET status = 'replaced' WHERE kind = 'revalidate' AND status = 'rejected' AND candidates = ?").run(JSON.stringify([id])); // its old rejection leaves the Rechazados list
      db.prepare('INSERT INTO verification_request(name, dni, email, candidates, created_at, dietary, kind) VALUES (?,?,?,?,?,?,?)')
        .run(g.name, '', g.email ?? '', JSON.stringify([id]), Date.now(), null, 'revalidate');
      audit(roleIn(req), 'guest_revalidate', { guestId: id });
      return { onHold: true };
    });
  });

  // Raffle participation per guest (default: everyone takes part).
  app.post('/api/admin/guests/:id/raffle', { ...staff, schema: { body: { type: 'object', required: ['participates'], additionalProperties: false, properties: { participates: { type: 'boolean' } } } } }, async (req, reply) => {
    const id = Number((req.params as any).id), { participates } = req.body as { participates: boolean };
    if (!db.prepare('UPDATE guest SET raffle_out = ? WHERE id = ?').run(participates ? 0 : 1, id).changes) return reply.code(404).send({ error: 'not_found' });
    audit(roleIn(req), 'guest_raffle', { guestId: id, participates });
    return { participates };
  });

  app.post('/api/admin/guests/:id/walkin', staff, async (req, reply) => {
    const id = Number((req.params as any).id);
    return state.tx(() => {
      if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
      return walkIn(id, roleIn(req), {});
    });
  });

  app.post('/api/admin/guests', {
    ...staff,
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 }, email: { type: 'string', maxLength: 120 } } } },
  }, async (req, reply) => {
    const { name: raw, email } = req.body as { name: string; email?: string };
    const name = raw.replace(/\s+/g, ' ').trim();
    if (nameTokens(name).length < 1 || (email?.trim() && !validEmail(email))) return reply.code(400).send({ error: 'invalid_input' });
    return state.tx(() => {
      if (db.prepare('SELECT 1 FROM guest WHERE name = ?').get(name)) return reply.code(409).send({ error: 'guest_exists' });
      const id = Number(db.prepare('INSERT INTO guest(name, email, walk_in) VALUES (?,?,1)').run(name, normEmail(email)).lastInsertRowid);
      return walkIn(id, roleIn(req), { added: name });
    });
  });

  app.post('/api/admin/guests/:id/checkin', staff, async (req, reply) => {
    const id = (req.params as any).id;
    if (!db.prepare('SELECT 1 FROM guest WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    const reg = db.prepare('SELECT checked_in_at FROM registration WHERE guest_id = ?').get(id) as { checked_in_at: number | null } | undefined;
    if (!reg) return reply.code(409).send({ error: 'not_registered' });
    if (!reg.checked_in_at && db.prepare('SELECT on_hold FROM registration WHERE guest_id = ?').get(id)?.on_hold) return reply.code(409).send({ error: 'pending_validation' });
    if (!reg.checked_in_at && !checkinOpen()) return reply.code(409).send({ error: 'checkin_not_open' });
    const at = reg.checked_in_at ?? Date.now(); // idempotent: keeps the first check-in time
    if (!reg.checked_in_at) {
      db.prepare('UPDATE registration SET checked_in_at = ? WHERE guest_id = ?').run(at, id);
      audit(roleIn(req), 'guest_checkin', { guestId: Number(id) });
    }
    return { checkedInAt: at };
  });

  app.post('/api/admin/checkin/:token', {
    ...staff,
    schema: { body: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { enum: ['checkin', 'deliver'] } } } },
  }, async (req, reply) => {
    const token = canonical(db, 'checkin_token', (req.params as any).token as string);
    const v = state.checkinView(token);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    const { action } = req.body as { action: 'checkin' | 'deliver' };
    const now = Date.now();
    if (action === 'checkin') {
      if (v.checkedInAt) return reply.code(409).send({ error: 'already_checked_in' });
      if (v.onHold) return reply.code(409).send({ error: 'pending_validation' });
      if (!checkinOpen()) return reply.code(409).send({ error: 'checkin_not_open' });
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

  // Optional body { prize }: the prize name shown on the stage winner plate. No body keeps the old call working.
  app.post('/api/admin/raffle', admin, async (req, reply) => {
    const rawPrize = (req.body as { prize?: unknown } | undefined)?.prize;
    if (rawPrize !== undefined && (typeof rawPrize !== 'string' || rawPrize.length > 80)) return reply.code(400).send({ error: 'invalid_input' });
    const prize = (rawPrize ?? '').replace(/\s+/g, ' ').trim() || null;
    // Before event day nobody can be checked in: draws are rehearsals over every registration (wiped with /raffle/reset).
    const pool = db.prepare(
      `SELECT guest_id FROM registration WHERE ${checkinOpen() ? 'checked_in_at IS NOT NULL AND ' : ''}on_hold = 0 AND guest_id NOT IN (SELECT guest_id FROM raffle) AND guest_id NOT IN (SELECT id FROM guest WHERE raffle_out = 1)`
    ).all() as { guest_id: number }[];
    if (!pool.length) return reply.code(409).send({ error: 'no_candidates' });
    const pick = pool[randomInt(pool.length)].guest_id;
    const drawnAt = Date.now();
    const id = state.tx(() => {
      const id = Number(db.prepare('INSERT INTO raffle(guest_id, drawn_at, prize) VALUES (?,?,?)').run(pick, drawnAt, prize).lastInsertRowid);
      state.setSetting('raffleHidden', 0);
      state.setSetting('stage', { ...state.stage(), scene: 'winner', winner: id, at: drawnAt }); // the stage runs the same suspense, then holds the winner
      audit(roleIn(req), 'raffle', { id, guestId: pick, prize });
      return id;
    });
    const { name } = db.prepare('SELECT name FROM guest WHERE id = ?').get(pick) as { name: string };
    return { id, name, drawnAt, prize: prize ?? '' };
  });

  // Every draw, voided ones included (voidedAt set): the admin shows them struck through.
  app.get('/api/admin/raffle', admin, async () =>
    db.prepare("SELECT r.id, g.name, r.drawn_at AS drawnAt, COALESCE(r.prize, '') AS prize, r.voided_at AS voidedAt, r.delivered_at AS deliveredAt FROM raffle r JOIN guest g ON g.id = r.guest_id ORDER BY r.id").all());
  const hideLast = () => {
    const last = db.prepare('SELECT MAX(id) AS id FROM raffle').get() as { id: number | null };
    state.setSetting('raffleHidden', last.id ?? 0);
  };
  app.post('/api/admin/raffle/hide', admin, async (req, reply) => {
    hideLast();
    audit(roleIn(req), 'raffle_hide');
    return reply.code(204).send();
  });
  // "Limpiar": the stage goes back to the clean raffle plate and no screen shows the last winner until the next draw.
  app.post('/api/admin/raffle/clear', admin, async (req, reply) => {
    state.tx(() => {
      hideLast();
      state.setSetting('stage', { ...state.stage(), scene: 'raffle', winner: 0, at: Date.now() });
      audit(roleIn(req), 'raffle_clear');
    });
    return reply.code(204).send();
  });
  // Deletes every draw (test ones included) so the real raffle starts clean; the stage leaves the winner plate.
  app.post('/api/admin/raffle/reset', admin, async (req) => {
    const deleted = state.tx(() => {
      const n = Number(db.prepare('DELETE FROM raffle').run().changes);
      state.setSetting('raffleHidden', 0);
      const s = state.stage();
      state.setSetting('stage', { ...s, ...(s.scene === 'winner' ? { scene: 'raffle', at: Date.now() } : {}), winner: 0 });
      audit(roleIn(req), 'raffle_reset', { deleted: n });
      return n;
    });
    return { deleted };
  });
  // Absent winner: the draw is void (the guest stays out of later draws, the prize frees up) and no screen shows them any more.
  app.post('/api/admin/raffle/:id/void', admin, async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT voided_at FROM raffle WHERE id = ?').get(id) as { voided_at: number | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.voided_at) return reply.code(409).send({ error: 'already_voided' });
    state.tx(() => {
      const now = Date.now(), s = state.stage();
      db.prepare('UPDATE raffle SET voided_at = ? WHERE id = ?').run(now, id);
      if (s.winner === id) state.setSetting('stage', { ...s, scene: s.scene === 'winner' ? 'raffle' : s.scene, winner: 0, at: now });
      audit(roleIn(req), 'raffle_void', { id });
    });
    return reply.code(204).send();
  });
  app.post('/api/admin/raffle/:id/deliver', admin, async (req, reply) => {
    const id = Number((req.params as any).id);
    const r = db.prepare('UPDATE raffle SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND voided_at IS NULL').run(Date.now(), id);
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    audit(roleIn(req), 'raffle_deliver', { id });
    return reply.code(204).send();
  });

  // Everyone who won a prize: game prizes (score threshold) and raffle prizes (voided draws excluded).
  const prizeWinners = () => {
    const game = db.prepare(
      `SELECT g.name, r.prize_won_at AS at, r.prize_delivered_at AS deliveredAt, COALESCE((SELECT a.game FROM attempt a WHERE a.guest_id = g.id AND a.prize_won = 1 LIMIT 1), '') AS prize
       FROM registration r JOIN guest g ON g.id = r.guest_id WHERE r.prize_won_at IS NOT NULL`).all() as any[];
    const raffle = db.prepare(
      `SELECT r.id, g.name, COALESCE(r.prize, '') AS prize, r.drawn_at AS at, r.delivered_at AS deliveredAt
       FROM raffle r JOIN guest g ON g.id = r.guest_id WHERE r.voided_at IS NULL`).all() as any[];
    return [...game.map((r) => ({ kind: 'game', ...r })), ...raffle.map((r) => ({ kind: 'raffle', ...r }))].sort((a, b) => a.at - b.at);
  };
  app.get('/api/admin/winners', admin, async () => prizeWinners());
  app.get('/api/admin/winners.csv', admin, async (_req, reply) => {
    const lines = ['type,name,prize,won_at,delivered_at'];
    for (const r of prizeWinners()) lines.push([r.kind, r.name, r.prize, iso(r.at), iso(r.deliveredAt)].map(csvField).join(','));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="winners.csv"').send(lines.join('\n') + '\n');
  });

  // ---- Stage (LED wall): a vision mixer. Partial patches merge into the stored state; `at` marks every change.
  const text = (max: number) => ({ type: 'string', maxLength: max });
  const PHOTO_RE = /^(|media\/[\w.-]+\.(jpg|jpeg|png|webp))$/; // speaker photo: empty or an uploaded same-origin image
  app.get('/api/admin/stage', admin, async () => state.stage());
  app.put('/api/admin/stage', {
    ...admin,
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      scene: { enum: SCENES }, speaker: { type: 'integer', minimum: 0, maximum: 49 }, winner: { type: 'integer', minimum: 0 },
      speakers: { type: 'array', maxItems: 50, items: { type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, role: text(60), photo: { type: 'string', maxLength: 120, pattern: PHOTO_RE.source } } } },
      award: { type: 'integer', minimum: 0, maximum: 99 },
      awards: { type: 'array', maxItems: 60, items: { type: 'object', required: ['company'], additionalProperties: false,
        properties: { company: { type: 'string', minLength: 1, maxLength: 80 }, text: text(120) } } },
      prizes: { type: 'array', maxItems: 50, items: text(80) },
      ambient: { type: 'array', maxItems: 20, items: text(80) },
      // Same-origin path (media/intro.mp4) or an http(s) URL (a YouTube link included): it becomes a <video src>, or the stage builds the YouTube embed from the 11-char id.
      video: { type: 'string', maxLength: 300, pattern: /^(|https?:\/\/\S+|[\w/][\w./%-]*)$/.source },
    } } },
  }, async (req, reply) => {
    const p = req.body as Partial<ReturnType<State['stage']>>;
    if (p.winner && !db.prepare('SELECT 1 FROM raffle WHERE id = ? AND voided_at IS NULL').get(p.winner)) return reply.code(400).send({ error: 'unknown_winner' });
    const cur = state.stage();
    // `at` restarts the video plate: only a scene or video change bumps it, so cueing the next speaker or award never replays it.
    const next = { ...cur, ...p, at: p.scene !== undefined || p.video !== undefined ? Date.now() : cur.at };
    if (p.speakers) next.speakers = p.speakers.map((x) => ({ name: x.name.trim(), role: (x.role ?? '').trim(), ...(x.photo ? { photo: x.photo } : {}) })).filter((x) => x.name);
    if (p.awards) next.awards = p.awards.map((x) => ({ company: x.company.replace(/\s+/g, ' ').trim(), text: (x.text ?? '').replace(/\s+/g, ' ').trim() })).filter((x) => x.company);
    if (p.prizes) next.prizes = p.prizes.map((x) => x.trim()).filter(Boolean);
    if (p.ambient) next.ambient = p.ambient.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean); // empty list: the stage falls back to the defaults
    next.speaker = Math.max(0, Math.min(next.speaker, next.speakers.length - 1));
    next.award = Math.max(0, Math.min(next.award, next.awards.length - 1));
    state.tx(() => { state.setSetting('stage', next); audit(roleIn(req), 'stage', p); });
    return next;
  });
  // Stage video upload: the raw MP4 is the body (video/mp4), streamed to data/media and served at /media/. The stage video points at it right away.
  const MAX_MEDIA = 500 * 1024 * 1024;
  app.addContentTypeParser('video/mp4', (_req, payload, done) => done(null, payload));
  app.post('/api/admin/media', { ...admin, bodyLimit: MAX_MEDIA }, async (req, reply) => {
    const bad = (code: number, error: string) => reply.code(code).header('connection', 'close').send({ error });
    const body = req.body as Readable | undefined;
    if (!/^video\/mp4\b/i.test(req.headers['content-type'] ?? '')) return bad(415, 'mp4_required'); // Fastify's built-in text/plain parser also lands here
    if (typeof body?.pipe !== 'function') return bad(400, 'invalid_mp4');
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.mp4`, tmp = join(MEDIA_DIR, name + '.part');
    let size = 0, head = Buffer.alloc(0), notMp4 = false;
    const guard = new Transform({ // chunked bodies carry no content-length: count here; an MP4 has "ftyp" at byte 4
      transform(chunk, _e, cb) {
        size += chunk.length;
        if (size > MAX_MEDIA) return cb(new Error('too_large')); // destroys the request: the client sent more than it declared
        if (head.length < 12) head = Buffer.concat([head, chunk]).subarray(0, 12);
        if (head.length >= 12 && head.toString('latin1', 4, 8) !== 'ftyp') notMp4 = true;
        cb(null, notMp4 ? undefined : chunk); // a wrong file is drained, not stored: destroying the request would cut the 400 reply off
      },
    });
    try { await pipeline(body, guard, createWriteStream(tmp)); } catch (e) {
      rmSync(tmp, { force: true });
      return (e as Error).message === 'too_large' ? bad(413, 'too_large') : bad(500, 'upload_failed'); // e.g. disk full
    }
    if (notMp4 || head.length < 12) { rmSync(tmp, { force: true }); return bad(400, 'invalid_mp4'); }
    renameSync(tmp, join(MEDIA_DIR, name));
    const video = 'media/' + name;
    state.tx(() => { state.setSetting('stage', { ...state.stage(), video, at: Date.now() }); audit(roleIn(req), 'media_upload', { file: name, size }); });
    return { video, size };
  });
  // Speaker photo upload: raw JPEG/PNG/WebP body (up to 8 MB), stored next to the videos. Unlike the video it does not touch the stage.
  const MAX_IMAGE = 8 * 1024 * 1024;
  const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const imageKind = (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
    : b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
    : b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : '';
  for (const type of Object.keys(IMAGE_EXT)) app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_IMAGE }, (_req, body, done) => done(null, body));
  app.post('/api/admin/media/image', { ...admin, bodyLimit: MAX_IMAGE }, async (req, reply) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_EXT[type]) return reply.code(415).send({ error: 'image_required' });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || imageKind(body) !== type) return reply.code(400).send({ error: 'invalid_image' });
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.${IMAGE_EXT[type]}`;
    writeFileSync(join(MEDIA_DIR, name), body);
    audit(roleIn(req), 'image_upload', { file: name, size: body.length });
    return { path: 'media/' + name };
  });
  // WOW cue: every panel and the stage play their part of one sweep at cueAt (server clock), then the stage holds the title.
  app.post('/api/admin/stage/cue', admin, async (req) => {
    const now = Date.now();
    const next = { ...state.stage(), scene: 'title', cueAt: now + CUE_LEAD_MS, at: now };
    state.tx(() => { state.setSetting('stage', next); audit(roleIn(req), 'stage_cue'); });
    return next;
  });

  return { roleOf };
}
