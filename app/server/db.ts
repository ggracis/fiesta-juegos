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
    CREATE TABLE IF NOT EXISTS guest(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
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
  `);
  for (const c of ['checked_in_at', 'prize_won_at', 'prize_delivered_at']) addColumn(db, 'registration', c, 'INTEGER');
  addColumn(db, 'attempt', 'game', "TEXT NOT NULL DEFAULT 'distinto'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_config(game TEXT PRIMARY KEY, enabled INTEGER NOT NULL, sort INTEGER NOT NULL,
      threshold INTEGER NOT NULL, max_attempts INTEGER NOT NULL, params TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS screen(id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, game TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session(token TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS raffle(id INTEGER PRIMARY KEY, guest_id INTEGER NOT NULL UNIQUE REFERENCES guest(id), drawn_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS attempt_guest_game ON attempt(guest_id, game);
  `);
  const seedGame = db.prepare('INSERT OR IGNORE INTO game_config(game, enabled, sort, threshold, max_attempts, params) VALUES (?,?,?,?,?,?)');
  for (const g of GAMES) seedGame.run(g.id, g.ready ? 1 : 0, g.defaults.sort, g.defaults.threshold, g.defaults.maxAttempts, JSON.stringify(g.defaults.params));
  const seedSetting = db.prepare('INSERT OR IGNORE INTO setting(key, value) VALUES (?,?)');
  const defaults: Record<string, unknown> = { paused: false, transition: false, transitionText: '', prizeStock: 0, raffleShowSeconds: 15, raffleHidden: 0 };
  for (const [k, v] of Object.entries(defaults)) seedSetting.run(k, JSON.stringify(v));
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM guest').get() as { n: number };
  if (n === 0) {
    const names = readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
    const ins = db.prepare('INSERT OR IGNORE INTO guest(name) VALUES (?)');
    db.exec('BEGIN');
    for (const name of names) ins.run(name);
    db.exec('COMMIT');
  }
  return db;
}
