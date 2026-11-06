import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GAMES } from '../src/shared/games.js';

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

export function openDb(file: string, csvPath: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, dni TEXT, email TEXT);
    CREATE TABLE IF NOT EXISTS registration(
      guest_id INTEGER PRIMARY KEY REFERENCES guest(id),
      pin TEXT NOT NULL UNIQUE,
      ticket_token TEXT NOT NULL UNIQUE,
      checkin_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempt(
      id TEXT PRIMARY KEY,
      guest_id INTEGER NOT NULL REFERENCES guest(id),
      seed INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER, score INTEGER, duration_ms INTEGER);
    CREATE TABLE IF NOT EXISTS verification_request(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL, dni TEXT NOT NULL, email TEXT NOT NULL,
      candidates TEXT NOT NULL, -- JSON array of guest ids whose name matched
      created_at INTEGER NOT NULL);
  `);
  // Pilot DBs predate dni/email: add the columns and let the CSV seed fill them.
  const migrate = !(db.prepare('PRAGMA table_info(guest)').all() as { name: string }[]).some((c) => c.name === 'dni');
  if (migrate) db.exec('ALTER TABLE guest ADD COLUMN dni TEXT; ALTER TABLE guest ADD COLUMN email TEXT');
  for (const c of ['checked_in_at', 'prize_won_at', 'prize_delivered_at']) addColumn(db, 'registration', c, 'INTEGER');
  for (const t of ['registration', 'verification_request']) addColumn(db, t, 'dietary', 'TEXT'); // optional free text, NULL = none
  addColumn(db, 'verification_request', 'status', "TEXT NOT NULL DEFAULT 'pending'");
  for (const c of ['resolved_guest_id', 'resolved_at']) addColumn(db, 'verification_request', c, 'INTEGER');
  addColumn(db, 'verification_request', 'resolved_by', 'TEXT'); // admin role that approved/rejected
  addColumn(db, 'guest', 'walk_in', 'INTEGER NOT NULL DEFAULT 0'); // added by staff at the door, not from the invite list
  addColumn(db, 'attempt', 'game', "TEXT NOT NULL DEFAULT 'distinto'");
  addColumn(db, 'attempt', 'content', 'TEXT'); // JSON rounds incl. answers, frozen per attempt
  for (const c of ['prize_won', 'no_prize', 'offline']) addColumn(db, 'attempt', c, 'INTEGER NOT NULL DEFAULT 0'); // no_prize: over-max offline play, recorded but never wins
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer(attempt_id TEXT NOT NULL REFERENCES attempt(id), idx INTEGER NOT NULL, choice INTEGER, ms INTEGER NOT NULL, points INTEGER NOT NULL, PRIMARY KEY(attempt_id, idx));
    CREATE TABLE IF NOT EXISTS quiz_question(id INTEGER PRIMARY KEY, question TEXT NOT NULL UNIQUE, correct TEXT NOT NULL, wrong1 TEXT NOT NULL, wrong2 TEXT NOT NULL, wrong3 TEXT NOT NULL, category TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS pixel_image(id INTEGER PRIMARY KEY, file TEXT NOT NULL UNIQUE, label TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS game_config(game TEXT PRIMARY KEY, enabled INTEGER NOT NULL, sort INTEGER NOT NULL,
      threshold INTEGER NOT NULL, max_attempts INTEGER NOT NULL, params TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS screen(id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, game TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session(token TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS raffle(id INTEGER PRIMARY KEY, guest_id INTEGER NOT NULL UNIQUE REFERENCES guest(id), drawn_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS attempt_guest_game ON attempt(guest_id, game);
  `);
  addColumn(db, 'raffle', 'sample', 'TEXT'); // JSON names cycled on the panels before the reveal (includes the winner)
  const seedGame = db.prepare('INSERT OR IGNORE INTO game_config(game, enabled, sort, threshold, max_attempts, params) VALUES (?,?,?,?,?,?)');
  for (const g of GAMES) seedGame.run(g.id, g.ready ? 1 : 0, g.defaults.sort, g.defaults.threshold, g.defaults.maxAttempts, JSON.stringify(g.defaults.params));
  // New default param keys reach existing DBs; edited values are never overwritten.
  const setParams = db.prepare('UPDATE game_config SET params = ? WHERE game = ?');
  for (const g of GAMES) {
    const { params } = db.prepare('SELECT params FROM game_config WHERE game = ?').get(g.id) as { params: string };
    const merged = JSON.stringify({ ...g.defaults.params, ...JSON.parse(params) });
    if (merged !== params) setParams.run(merged, g.id);
  }
  const seedSetting =db.prepare('INSERT OR IGNORE INTO setting(key, value) VALUES (?,?)');
  const defaults: Record<string, unknown> = { paused: false, transition: false, transitionText: '', prizeStock: 0, raffleShowSeconds: 15, raffleHidden: 0, registrationValidation: 'name_dni_email' };
  for (const [k, v] of Object.entries(defaults)) seedSetting.run(k, JSON.stringify(v));
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM guest').get() as { n: number };
  if (n === 0 || migrate) {
    // CSV: name,dni,email (names have no commas); '#' lines are comments, the first other line is the header.
    const rows = readFileSync(csvPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(1).map((l) => l.split(',').map((c) => c.trim()));
    const ins = db.prepare('INSERT INTO guest(name, dni, email) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET dni = excluded.dni, email = excluded.email');
    db.exec('BEGIN');
    for (const [name, dni = '', email = ''] of rows) ins.run(name, dni, email);
    db.exec('COMMIT');
  }
  return db;
}
