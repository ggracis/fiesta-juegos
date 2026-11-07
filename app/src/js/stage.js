import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import confetti from 'canvas-confetti';
import { live, screenId, isDemo } from './api.js';
import { $, RM, cleanName, mulberry32 } from './common.js';
import { rafflePhase, scramble, SCRAMBLE_MS, LEAD_MS } from '../shared/raffle.js';
import { PANELS, CUE_LEAD_MS, cueDelay, cueMs } from '../shared/stage.js';

gsap.registerPlugin(SplitText);

// ---------- fixed 3328x832 canvas, scaled to fit (letterboxed in black) ----------
const W = 3328, MAX_TEXT = 1900;
const wall = $('#wall');
let scale = 1;
const fit = () => { scale = Math.min(innerWidth / W, innerHeight / 832); wall.style.transform = `translate(-50%, -50%) scale(${scale})`; };
addEventListener('resize', fit); fit();

const q = new URLSearchParams(location.search);
const preview = q.has('preview'); // admin thumbnail: muted, no operator chips, not listed as a screen
const demo = isDemo || q.has('demo');
const SLOT = PANELS + 1; // the stage plays the WOW cue after panel 4

// Operator chips (status, sound) only while the mouse moved recently, so the audience never sees them by accident.
const status = $('#status');
let statusText = '', opsTimer;
const showStatus = () => { status.textContent = statusText; status.hidden = !statusText || !document.body.classList.contains('ops'); };
const setStatus = (t) => { statusText = t; showStatus(); };
addEventListener('mousemove', () => {
  document.body.classList.add('ops'); document.body.style.cursor = 'default'; showStatus();
  clearTimeout(opsTimer);
  opsTimer = setTimeout(() => { document.body.classList.remove('ops'); document.body.style.cursor = ''; showStatus(); }, 5000);
});

// ---------- sound: browsers need one click before a video may play with sound ----------
const vid = $('#vi');
let soundOn = false;
const sound = $('#sound');
sound.hidden = preview || demo;
addEventListener('pointerdown', () => {
  if (preview || soundOn) return;
  soundOn = true; sound.hidden = true;
  if (!vid.paused) vid.muted = false;
});

// ---------- video: copied into memory once (blob), so it plays even if the connection drops later ----------
let vidUrl = null, vidObj = null;
async function loadVideo(url) {
  if (url === vidUrl) return;
  vidUrl = url;
  if (vidObj) { URL.revokeObjectURL(vidObj); vidObj = null; }
  $('[data-view="video"]').classList.toggle('empty', !url);
  if (!url) { vid.removeAttribute('src'); vid.load(); return; }
  const abs = new URL(url, location.href).href;
  if (preview) { vid.src = abs; return; } // ponytail: the thumbnail streams, only the wall keeps a local copy
  try {
    const r = await fetch(abs);
    if (!r.ok) throw new Error(String(r.status));
    const total = Number(r.headers.get('content-length')) || 0, reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (url !== vidUrl) return; // replaced meanwhile
      setStatus(total ? `Descargando video ${Math.round((got / total) * 100)} %` : `Descargando video ${Math.round(got / 1e6)} MB`);
    }
    vidObj = URL.createObjectURL(new Blob(parts, { type: r.headers.get('content-type') || 'video/mp4' }));
    vid.src = vidObj;
    setStatus('Video listo (copia local)');
    setTimeout(() => { if (statusText.startsWith('Video listo')) setStatus(''); }, 5000);
  } catch {
    vid.src = abs; // cross-origin without CORS, or offline: stream it and hope the browser buffered enough
    setStatus('Video en streaming: sin copia local');
  }
}
function playVideo() {
  if (!vid.getAttribute('src')) return;
  vid.currentTime = 0;
  vid.muted = preview || !soundOn;
  vid.play().catch(() => { vid.muted = true; vid.play().catch(() => {}); });
}

// ---------- state: polled from /api/live (or faked in demo mode) ----------
let S = null, offset = 0, inflight = false;
async function poll() {
  if (inflight) return;
  inflight = true;
  const t0 = Date.now();
  try {
    const l = await live(preview ? {} : { screenId: screenId(), game: 'stage' });
    offset = l.serverNow - (t0 + Date.now()) / 2;
    S = l.stage ?? null;
    if (S) loadVideo(S.video || null);
    if (statusText === 'Sin conexión') setStatus('');
  } catch { setStatus('Sin conexión'); } // keep showing the last good state
  finally { inflight = false; }
}

// Demo: every plate in turn with fake data; the theme flips after each round unless ?theme= pins it.
const DEMO_SPEAKERS = [{ name: 'Binbing Xiao', role: 'CEO' }, { name: 'Wilfred', role: 'Director' }, { name: 'Ignacio Dapena', role: 'Director de Energía Digital' }];
const DEMO_NAMES = ['Lucía Fernández', 'Martín Gómez', 'Sofía Herrera', 'Diego Castro', 'Valentina Ruiz', 'Joaquín Paredes', 'Camila Ortega', 'Tomás Aguirre', 'Florencia Vidal', 'Agustín Molina', 'Julieta Sosa', 'Matías Romero'];
const DEMO_PRIZES = ['Smart TV 55"', 'Notebook', 'Auriculares inalámbricos', 'Tablet', 'Reloj inteligente'];
const DEMO_STEPS = [['title', 8000], ['ambient', 32000], ['speaker', 6000, 0], ['speaker', 6000, 1], ['speaker', 6000, 2], ['raffle', 6000], ['draw', 21000], ['video', 6000], ['cue', 9000]];
const DEMO_CYCLE = DEMO_STEPS.reduce((a, s) => a + s[1], 0);
const demoT0 = Date.now(), pin = q.get('scene'), pinnedTheme = q.has('theme');
let demoRound = 0;
function demoState(now) {
  const winner = (n, drawnAt) => ({ id: n + 1, name: DEMO_NAMES[(n * 5 + 3) % DEMO_NAMES.length], prize: DEMO_PRIZES[n % DEMO_PRIZES.length], drawnAt });
  const base = { scene: 'title', at: 0, cueAt: 0, video: '', speaker: null, winner: null };
  if (pin) {
    const sp = DEMO_SPEAKERS[Number(q.get('speaker')) || 0] ?? DEMO_SPEAKERS[0];
    if (pin === 'suspense') return { ...base, scene: 'winner', winner: winner(0, now - LEAD_MS - 5000) }; // reel frozen mid-way
    if (pin === 'winner') return { ...base, scene: 'winner', winner: winner(0, 0) };
    if (pin === 'cue') return { ...base, cueAt: now - ((now - demoT0) % 9000) + 3000 }; // replays every 9 s
    return { ...base, scene: pin, speaker: sp };
  }
  const round = Math.floor((now - demoT0) / DEMO_CYCLE);
  if (round !== demoRound) { demoRound = round; if (!pinnedTheme) document.documentElement.classList.toggle('noche'); }
  let t = (now - demoT0) % DEMO_CYCLE, start = now - t;
  for (const [kind, ms, arg] of DEMO_STEPS) {
    if (t < ms) {
      if (kind === 'speaker') return { ...base, scene: 'speaker', speaker: DEMO_SPEAKERS[arg] };
      if (kind === 'draw') return { ...base, scene: 'winner', winner: winner(round, start) };
      if (kind === 'video') return { ...base, scene: 'video', at: start };
      if (kind === 'cue') return { ...base, cueAt: start + 2500 };
      return { ...base, scene: kind };
    }
    t -= ms; start += ms;
  }
  return base;
}

// ---------- what to show now ----------
const ARM_MS = 2600; // the wall fades to black this long before its part of the sweep (panels are sweeping meanwhile)
function desired(now) {
  const s = S;
  if (!s) return { view: 'black', key: 'black' };
  if (s.cueAt) {
    const t = cueMs(now, offset, s.cueAt, SLOT);
    if (t < 0 && t > -(CUE_LEAD_MS + cueDelay(SLOT) + 2000)) return t < -ARM_MS ? { keep: true } : { view: 'black', key: 'black' };
    if (t >= 0 && t < 4000 && s.scene === 'title') return { view: 'title', key: 'title', cue: true };
  }
  switch (s.scene) {
    case 'speaker': return s.speaker ? { view: 'speaker', key: `speaker|${s.speaker.name}|${s.speaker.role}` } : { view: 'black', key: 'black' };
    case 'raffle': return { view: 'raffle', key: 'raffle' };
    case 'ambient': return { view: 'ambient', key: 'ambient' };
    case 'video': return { view: 'video', key: `video|${s.at}` };
    case 'black': return { view: 'black', key: 'black' };
    case 'winner': {
      const w = s.winner;
      if (!w) return { view: 'raffle', key: 'raffle' };
      const { phase } = rafflePhase(now, offset, w.drawnAt, 1e12); // same server-synced timeline as the panels; the stage then holds the winner
      return phase === 'wait' || phase === 'suspense' ? { view: 'suspense', key: 'suspense|' + w.id } : { view: 'winner', key: `winner|${w.id}|${w.name}|${w.prize}` };
    }
    default: return { view: 'title', key: 'title' };
  }
}

// Shrinks a one-line text until it fits MAX_TEXT (names and prizes are free text).
function fitText(el, base) {
  el.style.fontSize = base ? base + 'px' : '';
  const w = el.scrollWidth;
  if (w > MAX_TEXT) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * MAX_TEXT) / w + 'px';
}
// NFC: names typed on some keyboards/CSVs arrive decomposed and the accent then drifts off its letter.
const nice = (n) => cleanName(String(n)).normalize('NFC');
const plates = [...document.querySelectorAll('.plate')];
const plate = (v) => plates.find((p) => p.dataset.view === v);
let curKey = null, curView = 'black', prevView = null, splits = [];

function fill(d) {
  const s = S;
  if (d.view === 'speaker') {
    $('#sp-role').textContent = (s.speaker.role || '').normalize('NFC');
    $('#sp-name').textContent = nice(s.speaker.name);
    fitText($('#sp-name'));
  } else if (d.view === 'winner' || d.view === 'suspense') {
    const w = s.winner, prize = w.prize ? 'Premio: ' + w.prize.normalize('NFC') : '';
    $(d.view === 'winner' ? '#wi-prize' : '#su-prize').textContent = prize;
    if (d.view === 'winner') { $('#wi-name').textContent = nice(w.name); fitText($('#wi-name')); fitText($('#wi-prize')); } else fitText($('#su-prize'));
  }
}

function show(d) {
  splits.forEach((x) => x.revert()); splits = [];
  prevView = curView; curView = d.view;
  fill(d);
  wall.classList.toggle('off', d.view === 'black');
  for (const p of plates) p.classList.toggle('on', p.dataset.view === d.view);
  if (prevView === 'video' && d.view !== 'video') setTimeout(() => { if (curView !== 'video') vid.pause(); }, 900);
  if (d.view === 'video') playVideo();
  if (d.view !== prevView) ambient(d.view === 'ambient');
  if (RM) return;
  if (d.cue) cueIntro();
  else if (d.view === 'winner' && prevView === 'suspense') revealWinner();
}

// ---------- the two big moments ----------
const xOf = (el) => { const r = el.getBoundingClientRect(), w = wall.getBoundingClientRect(); return (r.left + r.width / 2 - w.left) / scale; };
function sweep(ms) {
  $('#sweep i').animate([
    { transform: 'translateX(-1000px) skewX(-18deg)', opacity: 0 },
    { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 },
    { transform: `translateX(${W + 100}px) skewX(-18deg)`, opacity: 0 },
  ], { duration: ms, easing: 'cubic-bezier(.45,.05,.4,1)' });
}
// The gold band arrives from panel 4 and "paints" the title as it crosses: each letter appears when the band reaches it.
function cueIntro() {
  const p = plate('title'), SWEEP = 1600;
  const parts = [[...p.querySelectorAll('.logo')].find((e) => e.offsetParent), p.querySelector('.knot')]; // the logo variant of the current theme
  // Split letters lose their parent's background-clip gradient: the gold ones get .gold themselves.
  splits = [SplitText.create(p.querySelector('.t-main span'), { type: 'chars', charsClass: 'ch gold' }),
    SplitText.create(p.querySelector('.t-sub'), { type: 'chars', charsClass: 'ch' })];
  for (const el of [...parts, ...splits.flatMap((x) => x.chars)]) {
    gsap.fromTo(el, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power2.out', delay: (xOf(el) / W) * SWEEP * 0.001 * 0.9 });
  }
  sweep(SWEEP);
  unsplitLater(3200);
}
// Split letters are only needed while they move: put the plain text back afterwards (keeps the gold gradient and re-fits cleanly).
function unsplitLater(ms) {
  const mine = splits;
  setTimeout(() => { if (splits === mine) { mine.forEach((x) => x.revert()); splits = []; } }, ms);
}
function revealWinner() {
  const name = $('#wi-name');
  splits = [SplitText.create(name, { type: 'chars', charsClass: 'ch gold' })];
  unsplitLater(2600);
  gsap.from(splits[0].chars, { opacity: 0, y: 90, scale: 0.6, duration: 0.7, ease: 'back.out(2)', stagger: 0.045 });
  gsap.from('#wi-prize', { opacity: 0, y: -30, duration: 0.6, delay: 0.5 });
  sweep(1400);
  const noche = document.documentElement.classList.contains('noche');
  const colors = noche ? ['#F8E7BC', '#D4AF6A', '#E3283A', '#FFFFFF'] : ['#C8102E', '#C9A45C', '#F2A7B0', '#9E1B22'];
  const shot = (x, angle) => confetti({ particleCount: 120, angle, spread: 70, startVelocity: 70, origin: { x, y: 0.75 }, colors, scalar: 1.6, disableForReducedMotion: true });
  shot(0.3, 70); shot(0.7, 110);
  setTimeout(() => { shot(0.2, 65); shot(0.8, 115); }, 700);
}

// ---------- ambient: soft moments take turns (lema, faroles, dragón, oro) ----------
const MOMENTS = [...document.querySelectorAll('.amb')];
const MOMENT_MS = demo && !pin ? 8000 : 20000;
{ // lanterns and sparks: fixed pseudo-random layout, built once
  const r = mulberry32(2026), el = (cls, vars) => Object.assign(document.createElement('i'), { className: cls, style: vars });
  for (let i = 0; i < 16; i++) $('#lanterns').append(el('lantern', `--x:${Math.round(80 + (i / 16) * 3168 + r() * 120)}px;--k:${(0.55 + r() * 0.8).toFixed(2)};--t:${Math.round(16 + r() * 12)}s;--d:-${Math.round(r() * 24)}s;--dx:${Math.round(r() * 120 - 60)}px`));
  for (let i = 0; i < 12; i++) $('.embers').append(el('', `--x:${Math.round(260 + r() * 540)}px;--t:${(3.5 + r() * 3).toFixed(1)}s;--d:-${(r() * 6).toFixed(1)}s;--dx:${Math.round(r() * 160 - 100)}px`));
  for (let i = 0; i < 46; i++) $('#sparks').append(el('spark', `--x:${Math.round(300 + r() * 2728)}px;--y:${Math.round(40 + r() * 750)}px;--t:${(3 + r() * 4).toFixed(1)}s;--d:-${(r() * 7).toFixed(1)}s`));
}
let ambTimer = null, ambIdx = -1;
function ambient(on) {
  clearInterval(ambTimer); ambTimer = null;
  wall.classList.remove('m-dragon');
  if (!on) { for (const m of MOMENTS) m.classList.remove('on', 'run'); return; }
  const pinned = q.get('moment');
  const next = () => {
    ambIdx = pinned !== null ? Number(pinned) % MOMENTS.length : (ambIdx + 1) % MOMENTS.length;
    MOMENTS.forEach((m, i) => {
      if (i === ambIdx) m.classList.add('on', 'run');
      else if (m.classList.contains('on')) { m.classList.remove('on'); setTimeout(() => { if (!m.classList.contains('on')) m.classList.remove('run'); }, 2100); }
    });
    const m = MOMENTS[ambIdx].dataset.m;
    wall.classList.toggle('m-dragon', m === 'dragon');
    // The dragon moment: a gold band crosses the wall now and then, over the big 2026.
    if (m === 'dragon' && !RM) for (const at of [2500, 11000]) setTimeout(() => { if (curView === 'ambient' && MOMENTS[ambIdx].dataset.m === 'dragon') sweep(2000); }, at);
  };
  next();
  if (pinned === null) ambTimer = setInterval(next, MOMENT_MS);
}

// Suspense: random letters in the winner's shape, locking left to right, same letters as the panels (seeded by the raffle id).
let reelLast = -1;
function reel(now) {
  const w = S.winner, name = nice(w.name);
  const { phase, ms } = rafflePhase(now, offset, w.drawnAt, 1e12);
  const t = phase === 'suspense' ? ms : 0, step = RM ? 0 : Math.floor(t / SCRAMBLE_MS);
  if (step === reelLast) return;
  const first = reelLast === -1;
  reelLast = step;
  const el = $('#su-name');
  el.textContent = RM ? '…' : scramble(t, name, w.id);
  if (first) fitText(el, 230); // fit once: the scramble keeps the winner's shape all through the suspense
}

function tick() {
  const now = Date.now();
  if (demo) S = demoState(now);
  const d = desired(now);
  if (!d.keep && d.key !== curKey) { curKey = d.key; reelLast = -1; show(d); }
  if (curView === 'suspense') reel(now);
  requestAnimationFrame(tick);
}

if (!demo) { poll(); setInterval(poll, 1000); }
document.fonts?.ready.then(() => { curKey = null; }); // re-fit text once the web fonts are in
tick();

// ---------- service worker (server mode, production): page, fonts and assets survive a reload without internet ----------
if (!demo && !preview && import.meta.env.PROD && 'serviceWorker' in navigator) {
  const precache = (reg) => reg.active?.postMessage({ precache: [location.href, ...performance.getEntriesByType('resource').map((r) => r.name)] });
  navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').then(() => navigator.serviceWorker.ready).then((reg) => {
    if (document.readyState === 'complete') precache(reg); else addEventListener('load', () => precache(reg));
  }).catch(() => {});
}
