import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// 6-digit PIN kept as a string so leading zeros survive.
export function generatePin(isTaken: (pin: string) => boolean): string {
  for (let i = 0; i < 1000; i++) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!isTaken(pin)) return pin;
  }
  throw new Error('PIN space exhausted');
}

export const newToken = () => randomBytes(16).toString('base64url');

// Inserts a registration with a fresh PIN and tokens; returns the ticket token. Caller checks none exists yet.
export function createRegistration(db: DatabaseSync, guestId: number, dietary: string | null): string {
  const taken = db.prepare('SELECT 1 FROM registration WHERE pin = ? UNION ALL SELECT 1 FROM token_alias WHERE pin = ?');
  const ticket = newToken();
  db.prepare('INSERT INTO registration(guest_id, pin, ticket_token, checkin_token, created_at, dietary) VALUES (?,?,?,?,?,?)')
    .run(guestId, generatePin((p) => !!taken.get(p, p)), ticket, newToken(), Date.now(), dietary);
  return ticket;
}

// A deleted duplicate's emailed ticket, QR and PIN keep working: token_alias maps them to the surviving guest,
// and this returns the survivor's current value for that column (or the input unchanged when it is not an alias).
export function canonical(db: DatabaseSync, col: 'pin' | 'ticket_token' | 'checkin_token', value: string): string {
  const r = db.prepare(`SELECT r.${col} AS v FROM token_alias a JOIN registration r ON r.guest_id = a.guest_id WHERE a.${col} = ?`).get(value) as { v: string } | undefined;
  return r?.v ?? value;
}

export const MEDIA_DIR = join(import.meta.dirname, '..', 'data', 'media'); // uploaded stage videos: outside dist, so a rebuild never wipes them
export const PIXEL_DIR = join(import.meta.dirname, '..', 'data', 'content', 'pixel');

// One CSV line -> cells. Quoted fields may hold commas and "" escapes (no multi-line fields).
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}
