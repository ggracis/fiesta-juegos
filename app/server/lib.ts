import { randomBytes, randomInt } from 'node:crypto';

// 6-digit PIN kept as a string so leading zeros survive.
export function generatePin(isTaken: (pin: string) => boolean): string {
  for (let i = 0; i < 1000; i++) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!isTaken(pin)) return pin;
  }
  throw new Error('PIN space exhausted');
}

export const newToken = () => randomBytes(16).toString('base64url');

export const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
