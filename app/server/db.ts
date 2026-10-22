import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file: string, csvPath: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
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
