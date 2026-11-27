// El Diferente: a grid of Huawei logos, one of them changed in a single way.
// Kinds: 'hue' (colour shift in degrees), 'rot' (turned, degrees), 'scale' (smaller). Obvious first, subtle last.
export const LEVELS = [
  { n: 3, k: 'hue', d: 70 }, { n: 3, k: 'rot', d: 45 }, { n: 4, k: 'scale', d: 0.75 }, { n: 4, k: 'hue', d: 45 }, { n: 4, k: 'rot', d: 25 },
  { n: 5, k: 'hue', d: 30 }, { n: 5, k: 'rot', d: 15 }, { n: 6, k: 'scale', d: 0.9 }, { n: 6, k: 'rot', d: 10 }, { n: 6, k: 'rot', d: 7 },
];

export function makeRound(rng, lvl) {
  const base = { h: 0, rot: 0, scale: 1 }, odd = { ...base };
  const sign = rng() < 0.5 ? -1 : 1;
  if (lvl.k === 'scale') odd.scale = lvl.d;
  else odd[lvl.k === 'hue' ? 'h' : 'rot'] = sign * lvl.d;
  return { base, odd, oddIndex: Math.floor(rng() * lvl.n * lvl.n), cells: lvl.n * lvl.n };
}
