import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';

// 6-digit PIN kept as a string so leading zeros survive.
export function generatePin(isTaken: (pin: string) => boolean): string {
  for (let i = 0; i < 1000; i++) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!isTaken(pin)) return pin;
  }
  throw new Error('PIN space exhausted');
}

export const newToken = () => randomBytes(16).toString('base64url');

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
