// Pure offline logic for the venue panels. Storage / digest / clock / randomness are injected so node --test can drive it.
// Browser wiring lives in play.js; the server side is server/panel.ts.

const coded = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- ids + hashing that also work on http://<lan-ip> (not a secure context: no crypto.subtle / randomUUID there)
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const K = Uint32Array.from('428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'.split(' '), (x) => parseInt(x, 16));
// ponytail: plain-JS SHA-256 only as the insecure-context fallback (tiny inputs); the secure path uses crypto.subtle.
export function sha256js(str) {
  const m = new TextEncoder().encode(str), n = m.length, len = (((n + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(len); buf.set(m); buf[n] = 0x80;
  new DataView(buf.buffer).setUint32(len - 4, n * 8);
  const H = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = new DataView(buf.buffer).getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  const out = new DataView(new ArrayBuffer(32));
  H.forEach((v, i) => out.setUint32(i * 4, v)); // big-endian
  return out.buffer;
}
export const digest = (s) => (globalThis.crypto?.subtle ? crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)) : Promise.resolve(sha256js(s)));
export const hashPin = async (dig, salt, pin) => hex(await dig(salt + ':' + pin));

// ---- local PIN check against the cached roster; same error shape as /api/login so the UI treats both alike
export function createPinCheck(getRoster, { digest: dig = digest, now = Date.now, max = 5, lockMs = 30_000 } = {}) {
  let fails = 0, until = 0; // ponytail: per page load; a reload resets the counter (the hashes are in localStorage anyway)
  return async (pin) => {
    const roster = getRoster(), t = now();
    if (!roster) throw coded('no_roster');
    if (until > t) throw coded('locked', { locked: true, retryAfter: Math.ceil((until - t) / 1000) });
    const h = await hashPin(dig, roster.salt, pin);
    const g = roster.guests.find((x) => x.h === h);
    if (g) { fails = 0; return { guestId: g.id, name: g.name }; }
    const locked = ++fails >= max;
    if (locked) { fails = 0; until = t + lockMs; }
    throw coded('wrong_pin', { remaining: locked ? 0 : max - fails, locked, retryAfter: locked ? lockMs / 1000 : 0 });
  };
}

// ---- persistent FIFO queue ([{ kind:'attempt'|'result', attemptId, ... }]); memory is authoritative, storage best-effort
export function createQueue(storage, key = 'fiesta.queue') {
  let list = [];
  try { list = JSON.parse(storage.getItem(key)) || []; } catch {}
  const save = () => { try { storage.setItem(key, JSON.stringify(list)); } catch {} };
  return {
    items: () => [...list],
    push(item) { list.push(item); save(); },
    remove(item) { list = list.filter((x) => !(x.kind === item.kind && x.attemptId === item.attemptId)); save(); },
  };
}

// 4xx means the server understood and will never accept it; 401/408/429 are fixable by waiting or by staff logging in again.
export const isDefinitive = (e) => e?.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);

// Sends the head item until the queue is empty. Order is preserved: the first retryable failure stops the run.
export async function flush(queue, send) {
  for (let item; (item = queue.items()[0]);) {
    try { await send(item); } catch (e) { if (!isDefinitive(e)) return false; }
    queue.remove(item);
  }
  return true;
}

// Retries without a deadline: 1 s, 2 s, 4 s ... capped at 30 s. kick() also runs on `online` and after each good live poll.
export function createFlusher(queue, send, { setTimer = setTimeout, clearTimer = clearTimeout, onChange } = {}) {
  let running = false, delay = 0, timer;
  const kick = async () => {
    if (running) return;
    running = true; clearTimer(timer);
    let ok = false;
    try { ok = await flush(queue, send); } finally { running = false; }
    delay = ok ? 0 : Math.min(delay ? delay * 2 : 1000, 30_000);
    if (!ok) timer = setTimer(kick, delay);
    onChange?.(queue.items().length, ok);
    return ok;
  };
  return { kick, delay: () => delay };
}

// ---- offline attempts (server never sees them until sync)
export const queuedAttempts = (queue, guestId, game) => queue.items().filter((i) => i.kind === 'attempt' && i.guestId === guestId && i.game === game).length;

export function attemptsLeft(roster, queue, guestId, game) {
  const cfg = roster?.games.find((g) => g.id === game);
  const used = (roster?.guests.find((g) => g.id === guestId)?.a?.[game] ?? 0) + queuedAttempts(queue, guestId, game);
  return cfg ? Math.max(0, cfg.maxAttempts - used) : 0;
}

export function startLocalAttempt({ roster, queue, guestId, game, id = uuid, rand = Math.random, now = Date.now }) {
  const cfg = roster?.games.find((g) => g.id === game && g.offline);
  if (!cfg) throw coded('game_unavailable');
  if (!attemptsLeft(roster, queue, guestId, game)) throw coded('max_attempts');
  const item = { kind: 'attempt', attemptId: id(), guestId, game, seed: 1 + Math.floor(rand() * 2 ** 30), startedAt: now() };
  queue.push(item);
  return { attemptId: item.attemptId, seed: item.seed, offline: true };
}

// Keeps cached counts honest once an attempt exists on the server (so a later offline start can't exceed maxAttempts).
export function bumpCount(roster, guestId, game) {
  const g = roster?.guests.find((x) => x.id === guestId);
  if (g) g.a = { ...g.a, [game]: (g.a?.[game] ?? 0) + 1 };
}
