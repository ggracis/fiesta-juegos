import gsap from 'gsap';
import { roundScore, totalScore, ROUNDS, ROUND_TIMEOUT_MS } from '../../shared/scoring.js';
import { $, mascot, mulberry32, wait } from '../common.js';

const ACCS = ['none', 'hat', 'bow', 'antenna'];
const SHAPES = ['round', 'tall', 'box'];
const LEVELS = [
  { n: 3, k: 'hue', d: 70 }, { n: 3, k: 'acc' }, { n: 4, k: 'hue', d: 45 }, { n: 4, k: 'acc' }, { n: 4, k: 'eye', d: 5 },
  { n: 5, k: 'hue', d: 20 }, { n: 5, k: 'eye', d: 3.5 }, { n: 6, k: 'hue', d: 12 }, { n: 6, k: 'eye', d: 3 }, { n: 6, k: 'hue', d: 8 },
];

function makeRound(rng, lvl) {
  const h0 = Math.floor(rng() * 360);
  const base = { h: h0 > 135 && h0 < 185 ? h0 + 60 : h0, // mint is reserved for "correct"
    ex: 0, acc: lvl.k === 'acc' ? 'none' : ACCS[Math.floor(rng() * ACCS.length)], shape: SHAPES[Math.floor(rng() * 3)] };
  const odd = { ...base };
  const sign = rng() < 0.5 ? -1 : 1;
  if (lvl.k === 'hue') { odd.h = (base.h + sign * lvl.d + 360) % 360; odd.cue = lvl.d <= 20; } // small hue gaps also get a shape cue (colour-blind players)
  else if (lvl.k === 'eye') odd.ex = sign * lvl.d;
  else odd.acc = ACCS[1 + Math.floor(rng() * 3)];
  return { base, odd, oddIndex: Math.floor(rng() * lvl.n * lvl.n), cells: lvl.n * lvl.n };
}

function countTo(el, from, to, dur) {
  const o = { v: from };
  gsap.to(o, { v: to, duration: dur, ease: 'power1.out', onUpdate: () => { el.textContent = Math.round(o.v); } });
}

const HAND = '<svg class="hand" id="dhand" viewBox="0 0 100 130" aria-hidden="true"><path d="M38 6a10 10 0 0 1 20 0v52l8-3c9-3 17 5 13 14l-12 40c-3 9-10 16-20 16H44c-10 0-18-6-24-14L6 88c-4-6 1-14 8-12l14 5V6a10 10 0 0 1 10 0z" fill="#fff"/></svg>';

// How-to illustration: a 3x3 demo grid with a halo, a tapping hand and a "+10" float.
function art(el, setStep) {
  const r = makeRound(mulberry32(7), { n: 3, k: 'hue', d: 70 });
  el.innerHTML = `<div class="demo" id="demo">${Array.from({ length: 9 }, (_, i) => `<span>${mascot(i === 4 ? r.odd : r.base)}</span>`).join('')}<div class="halo" id="halo"></div>${HAND}<b class="plus" id="dplus">+10</b></div>`;
  const cell = $('#demo', el).children[4]; // odd one
  const dx = cell.offsetLeft, dy = cell.offsetTop;
  gsap.set('#halo', { x: dx - 24, y: dy - 24, opacity: 0 });
  gsap.set('#dplus', { x: dx + 50, y: dy - 10, opacity: 0 });
  gsap.set('#dhand', { x: dx + 400, y: dy + 300, opacity: 0 });
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 })
    .call(setStep, [0], 0)
    .call(setStep, [1], 1.2)
    .fromTo('#halo', { opacity: 0, scale: 1 }, { opacity: 1, scale: 1.12, duration: 0.5, yoyo: true, repeat: 3, ease: 'sine.inOut' }, 1.2)
    .call(setStep, [2], 2.4)
    .to('#dhand', { opacity: 1, x: dx + 50, y: dy + 60, duration: 0.5, ease: 'power2.out' }, 2.4)
    .to('#dhand', { scale: 0.88, duration: 0.1, yoyo: true, repeat: 1 }, 3.0)
    .fromTo('#dplus', { opacity: 1, y: dy - 10 }, { opacity: 0, y: dy - 110, duration: 0.8, ease: 'power1.out' }, 3.05)
    .to('#dhand', { opacity: 0, duration: 0.3 }, 3.5)
    .to('#halo', { opacity: 0, duration: 0.2 }, 3.5);
  return () => tl.kill();
}

const abortError = () => new DOMException('aborted', 'AbortError');

async function play(root, ctx) {
  const rounds = [];
  const t0 = performance.now();
  const pips = $('#pips', root), scorenum = $('#scorenum', root);
  pips.innerHTML = '<i></i>'.repeat(ROUNDS);
  scorenum.textContent = '0';
  let shown = 0;
  for (let i = 0; i < ROUNDS; i++) {
    pips.children[i].classList.add('cur');
    const res = await playRound(root, makeRound(ctx.rng, LEVELS[i]), LEVELS[i], i, ctx);
    rounds.push(res);
    pips.children[i].className = res.found ? 'ok' : 'miss';
    const total = totalScore(rounds);
    countTo(scorenum, shown, total, 0.5); shown = total;
  }
  return { score: totalScore(rounds), durationMs: Math.round(performance.now() - t0) };
}

function playRound(root, { base, odd, oddIndex, cells }, lvl, idx, { sfx, signal }) {
  if (signal.aborted) return Promise.reject(abortError());
  const n = lvl.n, grid = $('#grid', root);
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  const tilt = mulberry32(oddIndex * 31 + n);
  grid.innerHTML = Array.from({ length: cells }, (_, i) =>
    `<div class="cell" data-i="${i}">${mascot({ ...(i === oddIndex ? odd : base), tilt: Math.round((tilt() - 0.5) * 10) })}</div>`).join('');
  const cellEls = [...grid.children];
  gsap.fromTo(cellEls, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(1.7)', stagger: { each: 0.015, from: 'center', grid: [n, n] } });

  // round banner wipes across; the timer starts when it has passed
  $('#bantxt', root).textContent = `Ronda ${idx + 1}`;
  $('#banbadge', root).hidden = idx < 6;
  gsap.timeline().set('#banner', { visibility: 'visible', xPercent: -100 })
    .to('#banner', { xPercent: 0, duration: 0.22, ease: 'power3.out' })
    .to('#banner', { xPercent: 100, duration: 0.22, ease: 'power3.in' }, '+=0.16')
    .set('#banner', { visibility: 'hidden' });

  return new Promise((resolve, reject) => {
    let tl = null, done = false;
    const stop = () => { done = true; tl?.kill(); grid.onpointerdown = null; };
    const abort = () => { stop(); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });

    wait(600).then(() => {
      if (signal.aborted) return;
      const bar = $('#timebar', root), num = $('#timenum', root);
      const secs = ROUND_TIMEOUT_MS / 1000;
      bar.classList.remove('hurry'); num.classList.remove('hurry'); num.textContent = secs;
      gsap.set(bar, { scaleX: 1, backgroundColor: '#FFC14D' });
      const start = performance.now();
      let wrong = 0;

      tl = gsap.timeline({ onComplete: () => finish(false) });
      tl.to(bar, { scaleX: 0, duration: secs, ease: 'none', onUpdate: () => { num.textContent = Math.max(0, Math.ceil(secs - tl.time())); } }, 0)
        .to(bar, { backgroundColor: '#FF8A3D', duration: 0.3 }, secs - 3)
        .to(bar, { backgroundColor: '#E4002B', duration: 0.3 }, secs - 1.5)
        .call(() => { bar.classList.add('hurry'); num.classList.add('hurry'); }, [], secs - 3);

      const center = (el) => ({ x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 });
      const floatAt = (el, text, bad) => {
        const { x, y } = center(el);
        const f = document.createElement('div');
        f.className = 'float' + (bad ? ' bad' : '');
        f.textContent = text;
        f.style.left = x + 'px'; f.style.top = y + 'px';
        grid.append(f);
        gsap.to(f, { y: -110, opacity: 0, duration: 0.9, ease: 'power1.out', onComplete: () => f.remove() });
      };

      function finish(found) {
        if (done) return;
        stop();
        const ms = performance.now() - start;
        const odds = cellEls[oddIndex];
        bar.classList.remove('hurry'); num.classList.remove('hurry');
        if (found) {
          const sc = roundScore({ found, ms, wrong });
          sfx.good();
          odds.insertAdjacentHTML('beforeend', '<div class="ok"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="26" fill="#2BD9A0"/><path d="m14 27 8 8 16-17" fill="none" stroke="#2B0B12" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>');
          gsap.timeline().to(odds, { scale: 1.25, zIndex: 3, duration: 0.3, ease: 'back.out(3)' });
          gsap.from(odds.lastElementChild, { scale: 0.6, opacity: 0, duration: 0.35, ease: 'back.out(2)' });
          floatAt(odds, `+${sc}`);
          const { x, y } = center(odds);
          for (let k = 0; k < 12; k++) {
            const s = document.createElement('i');
            s.className = 'spark'; s.style.left = x + 'px'; s.style.top = y + 'px';
            grid.append(s);
            const a = (k / 12) * Math.PI * 2;
            gsap.to(s, { x: Math.cos(a) * 130, y: Math.sin(a) * 130, scale: 0, duration: 0.6, ease: 'power2.out', onComplete: () => s.remove() });
          }
          gsap.to(cellEls.filter((_, i) => i !== oddIndex), { scale: 0, opacity: 0, duration: 0.25, ease: 'power2.in', stagger: { each: 0.03, from: oddIndex, grid: [n, n] } });
        } else {
          sfx.bad();
          gsap.fromTo(odds, { scale: 1 }, { scale: 1.2, duration: 0.3, yoyo: true, repeat: 3, ease: 'sine.inOut', zIndex: 3 });
          odds.insertAdjacentHTML('beforeend', '<div class="ok"></div>');
          floatAt(odds, 'Se acabó el tiempo', true);
        }
        wait(found ? 500 : 1000).then(() => {
          if (signal.aborted) return;
          signal.removeEventListener('abort', abort);
          resolve({ found, ms, wrong });
        });
      }

      grid.onpointerdown = (e) => {
        if (!e.isPrimary || done || signal.aborted) return;
        e.preventDefault();
        const c = e.target.closest('.cell');
        if (!c) return;
        if (+c.dataset.i === oddIndex) return finish(true);
        wrong++; sfx.bad();
        c.classList.remove('wrong'); void c.offsetWidth; c.classList.add('wrong');
        setTimeout(() => c.classList.remove('wrong'), 600);
        floatAt(c, '−2', true);
        gsap.fromTo('#game', { x: 6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.3)' });
      };
    });
  });
}

export default {
  id: 'distinto',
  howTo: { title: 'Así se juega', steps: ['Mira', 'Encuentra', 'Toca'], art },
  play,
};
