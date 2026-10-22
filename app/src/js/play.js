import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import confetti from 'canvas-confetti';
import { login, startAttempt, finishAttempt, screenId } from './api.js';
import { roundScore, totalScore, ROUNDS, ROUND_TIMEOUT_MS } from '../shared/scoring.js';
import { $, injectSprite, mascot, demoBadge, cleanName, firstName } from './common.js';

gsap.registerPlugin(SplitText);
injectSprite();
demoBadge();

const IDLE_MS = 20_000, HOWTO_MS = 10_000, BACK_S = 5;
const stage = $('#stage');

// ---------- kiosk touch hygiene (panel only) ----------
const fit = () => { stage.style.transform = `translate(-50%, -50%) scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`; };
addEventListener('resize', fit); fit();
for (const ev of ['contextmenu', 'gesturestart', 'gesturechange', 'dblclick', 'selectstart', 'dragstart']) {
  document.addEventListener(ev, (e) => e.preventDefault());
}
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

let fsTried = false;
function goFullscreen() {
  if (fsTried || document.fullscreenElement) return;
  fsTried = true;
  try { document.documentElement.requestFullscreen?.()?.catch?.(() => {}); } catch {}
}

// First-pointer-only tap (pointerdown: no click delay); buttons get a 90 ms "press" class.
function tap(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    const b = e.target.closest('button');
    if (b) { b.classList.add('press'); setTimeout(() => b.classList.remove('press'), 90); }
    fn(e);
  });
}

// ---------- sound: off by default, tiny oscillator blips ----------
let ac = null, soundOn = false;
function blip(freq, dur = 0.1, type = 'sine', gain = 0.07, at = 0) {
  if (!soundOn || !ac) return;
  const t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  key: () => blip(660, 0.05, 'triangle'),
  good: () => { blip(880, 0.1); blip(1320, 0.16, 'sine', 0.07, 0.09); },
  bad: () => blip(150, 0.22, 'sawtooth', 0.05),
  fan: () => [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.2, 'triangle', 0.07, i * 0.12)),
};
tap($('#snd'), () => {
  ac ??= new (window.AudioContext || window.webkitAudioContext)();
  soundOn = !soundOn;
  $('#snd').setAttribute('aria-pressed', soundOn);
  $('#snd').setAttribute('aria-label', soundOn ? 'Silenciar' : 'Activar sonido');
  sfx.key();
});

// ---------- characters ----------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
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

// Blink scheduler: toggles a class on a couple of random visible characters (cheap, no per-node timers).
setInterval(() => {
  const all = [...document.querySelectorAll('.screen:not([hidden]) .mz')];
  for (let i = 0; i < 2 && all.length; i++) {
    const el = all[Math.floor(Math.random() * all.length)];
    el.classList.add('blink');
    setTimeout(() => el.classList.remove('blink'), 140);
  }
}, 600);

// ---------- screens + idle ----------
const screens = [...document.querySelectorAll('.screen')];
let current = 'attract', idleTimer, gid = 0, session = null, attempt = null, playerName = '';
let cancelRound = null, howTl = null, topsTl = null, backTimer = null, holaSplit = null;

function show(name) {
  current = name;
  stage.dataset.screen = name;
  for (const s of screens) s.hidden = !(s.id === name || (name === 'result' && s.id === 'game'));
  $('#game').classList.toggle('dim', name === 'result');
  bump();
}
function bump() {
  clearTimeout(idleTimer);
  if (current !== 'attract' && current !== 'result' && current !== 'game') idleTimer = setTimeout(toAttract, IDLE_MS);
}
addEventListener('pointerdown', bump, true);

function toAttract() {
  gid++; session = null; attempt = null; pin = ''; renderDots();
  cancelRound?.(); cancelRound = null; howTl?.kill(); clearInterval(backTimer);
  gsap.killTweensOf('#grid, #banner, .float, .spark');
  show('attract');
  renderTops();
}

function iris(fn) {
  const el = $('#iris');
  gsap.killTweensOf(el);
  el.hidden = false;
  gsap.fromTo(el, { clipPath: 'circle(0% at 50% 50%)' }, {
    clipPath: 'circle(75% at 50% 50%)', duration: 0.45, ease: 'power2.in',
    onComplete() {
      fn();
      gsap.to(el, { clipPath: 'circle(0% at 50% 50%)', duration: 0.5, ease: 'power2.out', delay: 0.05, onComplete: () => { el.hidden = true; } });
    },
  });
}

// ---------- local top 3 (this screen only) ----------
const readTop = () => { try { return JSON.parse(localStorage.getItem('fiesta.top')) || []; } catch { return []; } };
function saveTop(name, score) {
  const list = [...readTop(), { n: name, s: score }].sort((a, b) => b.s - a.s).slice(0, 3);
  try { localStorage.setItem('fiesta.top', JSON.stringify(list)); } catch {}
}
function renderTops() {
  const top = readTop();
  const box = $('#tops');
  topsTl?.kill();
  if (!top.length) { box.innerHTML = '<span style="opacity:1">Sé el primero en aparecer aquí</span>'; return; }
  box.innerHTML = '<span>Mejores puntajes de esta pantalla</span><span>' + top.map((t, i) => `<i style="font-style:normal">${i + 1}. ${t.n} <b>${t.s}</b></i>`).join('') + '</span>';
  const [a, b] = box.children;
  gsap.set(b, { opacity: 0 });
  topsTl = gsap.timeline({ repeat: -1, repeatDelay: 0 })
    .to(a, { opacity: 0, duration: 0.6 }, 3.4).to(b, { opacity: 1, duration: 0.6 }, 3.4)
    .to(b, { opacity: 0, duration: 0.6 }, 7.4).to(a, { opacity: 1, duration: 0.6 }, 7.4)
    .to({}, { duration: 0.6 });
}

// ---------- attract ----------
const FLOAT = [
  [70, 400, 350, 'tall', 'hat', 280], [1570, 380, 22, 'box', 'none', 280], [240, 690, 8, 'round', 'bow', 270],
  [1400, 690, 330, 'round', 'antenna', 270], [700, 740, 38, 'tall', 'none', 230], [1030, 740, 12, 'box', 'hat', 230],
];
const floaters = $('#floaters');
FLOAT.forEach(([x, y, h, shape, acc, size], i) => {
  const s = document.createElement('span');
  s.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;animation-delay:${i * -0.8}s`;
  s.innerHTML = mascot({ h, shape, acc, ex: (i % 3) - 1 });
  floaters.append(s);
});
const oddOne = floaters.children[3].firstElementChild; // the visibly odd one winks every 6 s
setInterval(() => { if (current === 'attract') { oddOne.classList.add('wink'); setTimeout(() => oddOne.classList.remove('wink'), 260); } }, 6000);

tap($('#attract'), () => { goFullscreen(); pin = ''; renderDots(); setMsg(''); topsTl?.kill(); show('pin'); sfx.key(); });

// ---------- PIN ----------
let pin = '', locked = false, lockTimer;
const dots = $('#dots'), padEl = $('#pad');
dots.innerHTML = '<i></i>'.repeat(6);
const setMsg = (t) => { $('#pinmsg').textContent = t || ' '; };
function renderDots() {
  dots.className = '';
  gsap.set(dots.children, { clearProps: 'all' });
  [...dots.children].forEach((d, i) => { d.className = pin[i] ? 'on' : ''; });
}

for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'exit']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = k === 'del' ? 'Borrar' : k === 'exit' ? 'Salir' : k;
  if (k === 'del' || k === 'exit') b.className = 'fn';
  b.dataset.k = k;
  padEl.append(b);
}
tap(padEl, (e) => {
  const b = e.target.closest('button');
  if (!b || locked) return;
  const k = b.dataset.k;
  if (k === 'exit') return toAttract();
  setMsg('');
  if (k === 'del') pin = pin.slice(0, -1);
  else if (pin.length < 6) pin += k;
  sfx.key();
  renderDots();
  if (pin.length === 6) submitPin();
});

function lock(seconds) {
  locked = true; padEl.classList.add('lock');
  let left = seconds;
  const tick = () => {
    if (left <= 0) { locked = false; padEl.classList.remove('lock'); setMsg(''); return; }
    setMsg(`Demasiados intentos. Espera ${left} s.`);
    left--; lockTimer = setTimeout(tick, 1000);
  };
  clearTimeout(lockTimer); tick();
}

async function submitPin() {
  const myGid = gid;
  locked = true;
  try {
    const d = await login(pin, screenId());
    if (myGid !== gid) return;
    session = d.session; playerName = d.name;
    dots.classList.add('ok');
    const mid = (dots.children.length - 1) / 2;
    gsap.to(dots.children, {
      x: (i) => (mid - i) * 100, scale: 0.7, duration: 0.4, delay: 0.25, ease: 'power2.in',
      onComplete: () => { if (myGid === gid) { locked = false; showConfirm(); } },
    });
  } catch (e) {
    if (myGid !== gid) return;
    locked = false;
    dots.classList.add('wrong'); sfx.bad();
    setTimeout(() => { pin = ''; renderDots(); }, 380);
    if (e.code === 'locked' || e.locked) lock(e.retryAfter || 30);
    else if (e.code === 'wrong_pin') setMsg(`PIN incorrecto. Te quedan ${e.remaining} intentos.`);
    else setMsg('No hay conexión. Inténtalo de nuevo.');
  }
}

// ---------- confirm ----------
function showConfirm() {
  const fn = firstName(playerName);
  $('#avatar').innerHTML = mascot({ h: 350, shape: 'round', acc: 'hat' }) + `<b>${fn[0].toUpperCase()}</b>`;
  $('#hola').textContent = `¡Hola, ${fn}!`;
  $('#full').textContent = `¿Eres ${cleanName(playerName)}?`;
  show('confirm');
  holaSplit?.revert();
  holaSplit = SplitText.create('#hola', { type: 'chars' });
  gsap.from(holaSplit.chars, { scale: 0, y: 60, opacity: 0, duration: 0.5, ease: 'back.out(2.2)', stagger: 0.03 });
  gsap.from('#avatar', { scale: 0.4, y: 80, duration: 0.6, ease: 'back.out(1.8)' });
}
tap($('#no'), toAttract);
tap($('#yes'), claim);

async function claim() {
  const myGid = gid;
  try {
    const d = await startAttempt(session);
    if (myGid !== gid) return;
    attempt = d;
    startHowto();
  } catch { toAttract(); }
}

// ---------- how to ----------
function startHowto() {
  const r = makeRound(mulberry32(7), { n: 3, k: 'hue', d: 70 });
  const demo = $('#demo');
  demo.querySelectorAll(':scope > span').forEach((s) => s.remove());
  demo.insertAdjacentHTML('afterbegin', Array.from({ length: 9 }, (_, i) => `<span>${mascot(i === 4 ? r.odd : r.base)}</span>`).join(''));
  const ring = $('#howring');
  ring.style.animation = 'none'; void ring.getBoundingClientRect(); ring.style.animation = '';
  show('howto');

  const caps = [...document.querySelectorAll('#caps li')];
  const on = (i) => caps.forEach((c, j) => c.classList.toggle('on', j === i));
  const cell = demo.children[4]; // odd one
  const dx = cell.offsetLeft, dy = cell.offsetTop;
  gsap.set('#halo', { x: dx - 24, y: dy - 24, opacity: 0 });
  gsap.set('#dplus', { x: dx + 50, y: dy - 10, opacity: 0 });
  gsap.set('#dhand', { x: dx + 400, y: dy + 300, opacity: 0 });
  howTl?.kill();
  howTl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 })
    .call(on, [0], 0)
    .call(on, [1], 1.2)
    .fromTo('#halo', { opacity: 0, scale: 1 }, { opacity: 1, scale: 1.12, duration: 0.5, yoyo: true, repeat: 3, ease: 'sine.inOut' }, 1.2)
    .call(on, [2], 2.4)
    .to('#dhand', { opacity: 1, x: dx + 50, y: dy + 60, duration: 0.5, ease: 'power2.out' }, 2.4)
    .to('#dhand', { scale: 0.88, duration: 0.1, yoyo: true, repeat: 1 }, 3.0)
    .fromTo('#dplus', { opacity: 1, y: dy - 10 }, { opacity: 0, y: dy - 110, duration: 0.8, ease: 'power1.out' }, 3.05)
    .to('#dhand', { opacity: 0, duration: 0.3 }, 3.5)
    .to('#halo', { opacity: 0, duration: 0.2 }, 3.5);

  clearTimeout(howTimer);
  howTimer = setTimeout(startGame, HOWTO_MS);
}
let howTimer;
tap($('#start'), () => startGame());
tap($('#skip'), () => startGame());

// ---------- game ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function countTo(el, from, to, dur) {
  const o = { v: from };
  gsap.to(o, { v: to, duration: dur, ease: 'power1.out', onUpdate: () => { el.textContent = Math.round(o.v); } });
}

async function startGame() {
  clearTimeout(howTimer);
  if (current !== 'howto' || !attempt) return;
  howTl?.kill();
  const myGid = ++gid;
  const { attemptId, seed } = attempt;
  const rng = mulberry32(seed);
  const rounds = [];
  const t0 = performance.now();
  const pips = $('#pips');
  pips.innerHTML = '<i></i>'.repeat(ROUNDS);
  $('#scorenum').textContent = '0';
  show('game');
  let shown = 0;
  for (let i = 0; i < ROUNDS; i++) {
    pips.children[i].classList.add('cur');
    const res = await playRound(makeRound(rng, LEVELS[i]), LEVELS[i], i, myGid);
    if (myGid !== gid) return;
    rounds.push(res);
    pips.children[i].className = res.found ? 'ok' : 'miss';
    const total = totalScore(rounds);
    countTo($('#scorenum'), shown, total, 0.5); shown = total;
  }
  const score = totalScore(rounds);
  const durationMs = Math.round(performance.now() - t0);
  let note = '';
  try { await finishAttempt(attemptId, score, durationMs); } catch { note = 'No se pudo guardar el resultado.'; }
  if (myGid !== gid) return;
  showResult(score, note);
}

async function playRound({ base, odd, oddIndex, cells }, lvl, idx, myGid) {
  const n = lvl.n, grid = $('#grid');
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  const tilt = mulberry32(oddIndex * 31 + n);
  grid.innerHTML = Array.from({ length: cells }, (_, i) =>
    `<div class="cell" data-i="${i}">${mascot({ ...(i === oddIndex ? odd : base), tilt: Math.round((tilt() - 0.5) * 10) })}</div>`).join('');
  const cellEls = [...grid.children];
  gsap.fromTo(cellEls, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(1.7)', stagger: { each: 0.015, from: 'center', grid: [n, n] } });

  // round banner wipes across; the timer starts when it has passed
  $('#bantxt').textContent = `Ronda ${idx + 1}`;
  $('#banbadge').hidden = idx < 6;
  gsap.timeline().set('#banner', { visibility: 'visible', xPercent: -100 })
    .to('#banner', { xPercent: 0, duration: 0.22, ease: 'power3.out' })
    .to('#banner', { xPercent: 100, duration: 0.22, ease: 'power3.in' }, '+=0.16')
    .set('#banner', { visibility: 'hidden' });
  await wait(600);
  if (myGid !== gid) return new Promise(() => {});

  return new Promise((resolve) => {
    const bar = $('#timebar'), num = $('#timenum');
    const secs = ROUND_TIMEOUT_MS / 1000;
    bar.classList.remove('hurry'); num.classList.remove('hurry'); num.textContent = secs;
    gsap.set(bar, { scaleX: 1, backgroundColor: '#FFC14D' });
    const start = performance.now();
    let wrong = 0, done = false;

    const tl = gsap.timeline({ onComplete: () => finish(false) });
    tl.to(bar, { scaleX: 0, duration: secs, ease: 'none', onUpdate: () => { num.textContent = Math.max(0, Math.ceil(secs - tl.time())); } }, 0)
      .to(bar, { backgroundColor: '#FF8A3D', duration: 0.3 }, secs - 3)
      .to(bar, { backgroundColor: '#E4002B', duration: 0.3 }, secs - 1.5)
      .call(() => { bar.classList.add('hurry'); num.classList.add('hurry'); }, [], secs - 3);

    cancelRound = () => { done = true; tl.kill(); grid.onpointerdown = null; };
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
      done = true; tl.kill(); grid.onpointerdown = null; cancelRound = null;
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
      wait(found ? 500 : 1000).then(() => resolve({ found, ms, wrong }));
    }

    grid.onpointerdown = (e) => {
      if (!e.isPrimary || done || myGid !== gid) return;
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
}

// ---------- result ----------
function showResult(score, note) {
  const prevBest = readTop()[0]?.s;
  const record = prevBest !== undefined && score > prevBest;
  saveTop(firstName(playerName), score);
  $('#rtitle').textContent = score > 70 ? '¡Increíble!' : score >= 40 ? '¡Muy bien!' : '¡Buen intento!';
  $('#rscore').textContent = '0';
  $('#rnote').textContent = note || ' ';
  $('#record').hidden = !record;
  show('result');
  sfx.fan();
  gsap.from('#medal', { y: -900, duration: 0.9, ease: 'bounce.out' });
  gsap.from('#rtitle', { scale: 0.5, opacity: 0, duration: 0.5, ease: 'back.out(2)', delay: 0.2 });
  countTo($('#rscore'), 0, score, 1.2);
  if (record) gsap.from('#record', { scale: 0, rotation: -20, duration: 0.5, ease: 'back.out(2.5)', delay: 1.1 });
  confetti({ particleCount: score > 70 ? 80 : 60, spread: 100, startVelocity: 45, origin: { y: 0.55 }, disableForReducedMotion: true, zIndex: 100, colors: ['#FFC14D', '#FF8A3D', '#FF5A4D', '#FF2D8A', '#FFF7F3'] });

  const myGid = gid;
  let left = BACK_S;
  const ring = $('#backring');
  ring.style.animation = 'none'; void ring.getBoundingClientRect();
  ring.style.animation = `drain ${BACK_S}s linear forwards`;
  $('#backtxt').textContent = `Volviendo en ${left}…`;
  clearInterval(backTimer);
  backTimer = setInterval(() => {
    if (myGid !== gid) return clearInterval(backTimer);
    left--;
    if (left <= 0) { clearInterval(backTimer); iris(toAttract); return; }
    $('#backtxt').textContent = `Volviendo en ${left}…`;
  }, 1000);
}

show('attract');
renderTops();
