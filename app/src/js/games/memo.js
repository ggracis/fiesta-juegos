import gsap from 'gsap';
import { memoScore, MEMO_PAIRS } from '../../shared/scoring.js';
import { gameById } from '../../shared/games.js';
import { $, RM, wait } from '../common.js';
import '../../css/memo.css';

// Placeholder icon pool (energy/tech), 64x64, stroke = currentColor, `.f` = gold accent.
// ponytail: bundled inline, so it works offline and in the static demo; swap for client art (square, >= 256 px) when it arrives.
const ICONS = [
  '<path class="f" d="M36 6 14 36h16l-4 22 22-30H32z"/>', // bolt
  '<circle class="f" cx="32" cy="32" r="11"/><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13.6 13.6l5.7 5.7M44.7 44.7l5.7 5.7M13.6 50.4l5.7-5.7M44.7 19.3l5.7-5.7"/>', // sun
  '<path class="f" d="M12 12h40l6 28H6z"/><path d="M9 26h46M25 12l-3 28M39 12l3 28M32 40v14M22 56h20"/>', // solar panel
  '<rect x="6" y="18" width="46" height="28" rx="5"/><path d="M57 27v10"/><rect class="f" x="12" y="24" width="20" height="16" rx="2"/>', // battery
  '<path d="M32 30v28M24 58h16"/><path class="f" d="M30 24C27 15 29 8 32 4c4 6 3 14-2 20zM36 27c9-1 15 3 18 7-7 3-14 1-18-7zM28 27c-4 8-11 10-18 7 3-4 9-8 18-7z"/><circle cx="32" cy="26" r="3"/>', // wind turbine
  '<path d="M24 6v12M40 6v12"/><path class="f" d="M16 18h32v10a16 16 0 0 1-32 0z"/><path d="M32 44v14"/>', // plug
  '<rect x="16" y="16" width="32" height="32" rx="4"/><rect class="f" x="25" y="25" width="14" height="14" rx="2"/><path d="M26 16V7M38 16V7M26 57v-9M38 57v-9M16 26H7M16 38H7M57 26h-9M57 38h-9"/>', // chip
  '<path d="M7 26a36 36 0 0 1 50 0M15 35a24 24 0 0 1 34 0M23 44a12 12 0 0 1 18 0"/><circle class="f" cx="32" cy="53" r="4"/>', // signal
  '<path class="f" d="M12 52C10 26 28 10 54 10c0 26-16 44-42 42z"/><path d="M12 52 36 28"/>', // leaf
  '<path class="f" d="M19 48h27a11 11 0 0 0 1-22 15 15 0 0 0-29-3 12.5 12.5 0 0 0 1 25z"/><path d="M32 44V32M26 38l6-6 6 6"/>', // cloud
  '<path d="M6 30 32 9l26 21M13 25v31h38V25"/><path class="f" d="M35 28 25 42h8l-3 10 10-14h-8z"/>', // smart home
  '<path d="M8 46a24 24 0 1 1 48 0M8 54h48"/><path d="M32 46 45 29"/><circle class="f" cx="32" cy="46" r="5"/>', // gauge
];
const icon = (i) => `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[i]}</svg>`;
const card = (i, n) => `<div class="mcard" data-n="${n}"><div class="in"><div class="back"></div><div class="face t${i % 2}">${icon(i)}</div></div></div>`;
const FLIP_BACK_MS = 800;

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// How-to illustration: 6 cards; a wrong pair flips back, then a matching pair stays open.
function art(el, setStep) {
  const deck = [0, 3, 6, 0, 6, 3]; // pairs at (0,3) and (2,4); (1,2) is the wrong try
  el.innerHTML = `<div class="demo mdemo">${deck.map((ic, n) => card(ic, n)).join('')}</div>`;
  const c = [...el.querySelectorAll('.mcard')];
  const open = (n, on) => () => c[n].classList.toggle('open', on);
  if (RM) { open(0, true)(); open(3, true)(); c[0].classList.add('done'); c[3].classList.add('done'); setStep(1); return () => {}; }
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 })
    .call(setStep, [0], 0).call(open(1, true), [], 0.4).call(open(2, true), [], 0.9)
    .call(() => { c[1].classList.add('no'); c[2].classList.add('no'); }, [], 1.2)
    .call(() => { [1, 2].forEach((n) => c[n].classList.remove('open', 'no')); }, [], 2.0)
    .call(setStep, [1], 2.4).call(open(0, true), [], 2.6).call(open(3, true), [], 3.1)
    .call(() => { c[0].classList.add('done'); c[3].classList.add('done'); }, [], 3.4)
    .call(setStep, [2], 4.2)
    .call(() => c.forEach((x) => x.classList.remove('open', 'done')), [], 5.6);
  return () => tl.kill();
}

const abortError = () => new DOMException('aborted', 'AbortError');

function play(root, { params, sfx, rng, idle, signal }) {
  if (signal.aborted) return Promise.reject(abortError());
  const p = { ...gameById('memo').defaults.params, ...params };
  const t0 = performance.now();
  const grid = $('#grid', root), pips = $('#pips', root), bar = $('#timebar', root), num = $('#timenum', root);
  const picks = shuffle([...ICONS.keys()], rng).slice(0, MEMO_PAIRS);
  const deck = shuffle([...picks, ...picks], rng);
  grid.style.gridTemplateColumns = grid.style.gridTemplateRows = 'repeat(4, 1fr)';
  grid.innerHTML = deck.map((ic, n) => card(ic, n)).join('');
  const cards = [...grid.children];
  pips.innerHTML = '<i></i>'.repeat(MEMO_PAIRS);
  bar.classList.remove('hurry'); num.classList.remove('hurry');
  gsap.set(bar, { scaleX: 1, clearProps: 'backgroundColor' }); // distinto tints the bar inline
  num.textContent = p.timeLimitS;
  if (!RM) gsap.fromTo(cards, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(1.7)', stagger: { each: 0.02, from: 'center', grid: [4, 4] } });

  return new Promise((resolve, reject) => {
    let tl = null, done = false, first = null, locked = false, pairs = 0, wrong = 0, start = 0;
    const stop = () => { done = true; tl?.kill(); grid.onpointerdown = null; idle.stop(); };
    const abort = () => { stop(); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });

    function end(finished) {
      if (done) return;
      stop();
      const ms = performance.now() - start;
      bar.classList.remove('hurry'); num.classList.remove('hurry');
      if (finished) sfx.good();
      else { sfx.bad(); cards.forEach((c) => c.classList.add('open')); } // show what was left
      wait(finished ? 700 : 1500).then(() => {
        if (signal.aborted) return;
        signal.removeEventListener('abort', abort);
        resolve({ score: memoScore({ finished, ms, wrong, pairs }, p), durationMs: Math.round(performance.now() - t0) });
      });
    }

    wait(RM ? 0 : 600).then(() => {
      if (signal.aborted) return;
      const secs = p.timeLimitS;
      start = performance.now();
      tl = gsap.timeline({ onComplete: () => end(false) })
        .to(bar, { scaleX: 0, duration: secs, ease: 'none', onUpdate: () => { num.textContent = Math.max(0, Math.ceil(secs - tl.time())); } }, 0)
        .call(() => { bar.classList.add('hurry'); num.classList.add('hurry'); }, [], Math.max(0, secs - 10));
      idle.start(() => end(false));

      grid.onpointerdown = (e) => {
        if (!e.isPrimary || done) return;
        e.preventDefault();
        idle.bump();
        const c = e.target.closest('.mcard');
        if (!c || locked || c === first || c.classList.contains('done')) return;
        c.classList.add('open');
        if (!first) { first = c; return; }
        const a = first; first = null;
        if (deck[a.dataset.n] === deck[c.dataset.n]) {
          a.classList.add('done'); c.classList.add('done');
          pips.children[pairs++].className = 'ok';
          sfx.good();
          if (!RM) gsap.fromTo([a, c], { scale: 1 }, { scale: 1.08, duration: 0.15, yoyo: true, repeat: 1, ease: 'power1.out' });
          if (pairs === MEMO_PAIRS) end(true);
          return;
        }
        wrong++; locked = true; sfx.bad();
        a.classList.add('no'); c.classList.add('no');
        if (!RM) gsap.fromTo(root, { x: 6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.3)' });
        setTimeout(() => { if (done) return; a.classList.remove('open', 'no'); c.classList.remove('open', 'no'); locked = false; }, FLIP_BACK_MS);
      };
    });
  });
}

export default {
  id: 'memo',
  howTo: { title: 'Así se juega', steps: ['Toca dos cartas', 'Encuentra los pares', 'Rápido y sin errores'], art },
  play,
};
