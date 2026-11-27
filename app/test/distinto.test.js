import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, TINT, makeRound } from '../src/shared/distinto-levels.js';

// How far the odd logo is from the others, on one scale per kind (bigger = easier to spot).
// A turned logo also gets a slight tint (TINT), so the ranking looks at the main change only.
const gap = ({ base, odd }) => (odd.rot ? Math.abs(odd.rot) / 45 : Math.abs(odd.h - base.h) / 70) + Math.abs(odd.scale - base.scale) / 0.3;

test('El Diferente: the odd Huawei logo differs in one way (a turn also tints a little), obvious first and subtle last', () => {
  let rng = 1;
  const next = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
  assert.equal(LEVELS.length, 10);
  const gaps = LEVELS.map((lvl) => {
    const r = makeRound(next, lvl);
    assert.deepEqual(r.base, { h: 0, rot: 0, scale: 1 }); // every other logo is the plain red one, never tilted
    const changed = Object.keys(r.odd).filter((k) => r.odd[k] !== r.base[k]);
    if (lvl.k === 'rot') assert.deepEqual([changed.sort(), Math.abs(r.odd.h)], [['h', 'rot'], TINT]); // turned and slightly recoloured
    else assert.equal(changed.length, 1);
    assert.ok(r.oddIndex >= 0 && r.oddIndex < r.cells && r.cells === lvl.n * lvl.n);
    return gap(r);
  });
  assert.ok(gaps[0] >= 1 && gaps[1] >= 1, 'first two levels are obvious');
  assert.ok(gaps.at(-1) < 0.2, 'last level is subtle');
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] <= gaps[i - 1], `level ${i + 1} is not easier than level ${i}`);
});
