import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file: string, csvPath: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
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
