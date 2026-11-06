// Builds src/data/demo-roster.json from data/guests.csv. Deterministic: same CSV -> same PINs and tokens.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
// CSV: name,dni,email ('#' lines are comments, first other line is the header). The roster is public demo data.
const rows = readFileSync(new URL('data/guests.csv', root), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(1).map((l) => l.split(',').map((c) => c.trim()));
const h = (s) => createHash('sha256').update('fiesta-demo:' + s).digest();
const used = new Set();
const roster = rows.map(([name, dni, email], i) => {
  const d = h(name);
  let n = d.readUInt32BE(0) % 1_000_000;
  while (used.has(n)) n = (n + 1) % 1_000_000;
  used.add(n);
  return {
    id: i + 1,
    name,
    dni,
    email,
    pin: String(n).padStart(6, '0'),
    ticketToken: d.subarray(4, 14).toString('base64url'),
    checkinToken: d.subarray(14, 24).toString('base64url'),
  };
});
writeFileSync(new URL('src/data/demo-roster.json', root), JSON.stringify(roster, null, 1) + '\n');
console.log(`${roster.length} demo guests written`);
