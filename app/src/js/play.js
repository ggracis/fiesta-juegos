import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import confetti from 'canvas-confetti';
import { login, startAttempt, finishAttempt, live, screenId, panelRoster, panelSync, isDemo } from './api.js';
import { createQueue, createFlusher, createPinCheck, startLocalAttempt, attemptsLeft, bumpCount } from './offline.js';
import { ROUND_GAMES } from '../shared/rounds.js';
import { rafflePhase, scramble, SCRAMBLE_MS } from '../shared/raffle.js';
import { PANELS, CUE_SWEEP_MS, cueMs } from '../shared/stage.js';
import { $, RM, injectSprite, mascot, demoBadge, cleanName, firstName, wait, mulberry32 } from './common.js';
import { GAME_MODULES } from './games/index.js';

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
  drum: () => { blip(95, 0.06, 'triangle', 0.09); blip(190, 0.03, 'square', 0.02); }, // every other scramble step: a steady drumroll
};
tap($('#snd'), () => {
  ac ??= new (window.AudioContext || window.webkitAudioContext)();
  soundOn = !soundOn;
  $('#snd').setAttribute('aria-pressed', soundOn);
  $('#snd').setAttribute('aria-label', soundOn ? 'Silenciar' : 'Activar sonido');
  sfx.key();
});

// ---------- characters ----------
// Blink scheduler: toggles a class on a couple of random visible characters (cheap, no per-node timers).
setInterval(() => {
  const all = [...document.querySelectorAll('.screen:not([hidden]) .mz')];
  for (let i = 0; i < 2 && all.length; i++) {
    const el = all[Math.floor(Math.random() * all.length)];
    el.classList.add('blink');
    setTimeout(() => el.classList.remove('blink'), 140);
  }
}, 600);

// ---------- offline: roster cache, result queue, indicator ----------
// Server unreachable = network error or 5xx (Caddy answers 502 when node is down).
const down = (e) => e.code === 'network' || e.status >= 500;
const store = (() => { try { localStorage.getItem('x'); return localStorage; } catch { return { getItem: () => null, setItem() {} }; } })();
let roster = null, netOk = true;
try { roster = JSON.parse(store.getItem('fiesta.roster')); } catch {}
const saveRoster = () => { if (roster) try { store.setItem('fiesta.roster', JSON.stringify(roster)); } catch {} };
const queue = createQueue(store);
const pinCheck = createPinCheck(() => roster);
const outcome = new Map(); // attemptId -> resolver of the server's prize answer (only while the result screen waits)
const settle = (id, won) => { outcome.get(id)?.(won); outcome.delete(id); };

// Offline attempts and their results go through the staff-authenticated sync; online attempts finish via the public endpoint.
async function sendItem(it) {
  if (it.kind === 'attempt' || it.offline) {
    const r = (await panelSync([it])).results[0];
    if (it.kind === 'attempt') { if (r.ok) { bumpCount(roster, it.guestId, it.game); saveRoster(); } } else settle(it.attemptId, !!r.prizeWon);
  } else settle(it.attemptId, !!(await finishAttempt(it.attemptId, it.score, it.durationMs)).prizeWon);
}
function showNet() {
  const n = queue.items().length;
  $('#offline').hidden = netOk;
  $('#offline').textContent = 'Sin conexión' + (n ? ` · ${n} por enviar` : '');
}
const flusher = createFlusher(queue, sendItem, { onChange: showNet });
addEventListener('online', () => { poll(); flusher.kick(); });
if (queue.items().length) flusher.kick();

function renderSetup() {
  const when = roster ? new Date(roster.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
  $('#setupinfo').textContent = (roster ? `${roster.guests.length} invitados guardados (${when})` : 'Sin datos guardados')
    + (queue.items().length ? ` · ${queue.items().length} por enviar` : '');
}
async function refreshRoster() {
  if (isDemo) return;
  try { roster = await panelRoster(); saveRoster(); } catch {} // 401 (staff not logged in) or offline: keep the cached one
  renderSetup();
}
refreshRoster();
setInterval(refreshRoster, 300_000);
if (new URLSearchParams(location.search).has('setup') && !isDemo) {
  $('#setup').hidden = false;
  tap($('#setupbtn'), () => { location.href = new URL('admin.html?next=' + encodeURIComponent(location.pathname + location.search), location.href).href; });
}

// ---------- screens + idle ----------
const screens = [...document.querySelectorAll('.screen')];
let current = 'attract', idleTimer, gid = 0, session = null, attempt = null, playerName = '';
let local = null, playerId = null; // local: offline session { offline, guestId, name } (PIN checked against the cached roster)
let gameId = null, howStop = null, gameAbort = null, curIdle = null, backTimer = null, holaSplit = null;

function show(name) {
  current = name;
  stage.dataset.screen = name;
  for (const s of screens) s.hidden = !(s.id === name || (name === 'result' && s.id === 'game'));
  $('#game').classList.toggle('dim', name === 'result');
  bump();
  applyOverlays();
}
function bump() {
  clearTimeout(idleTimer);
  if (current !== 'attract' && current !== 'result' && current !== 'game') idleTimer = setTimeout(toAttract, IDLE_MS);
}
addEventListener('pointerdown', bump, true);

function toAttract() {
  gid++; session = null; local = null; playerId = null; attempt = null; gameId = null; pin = ''; renderDots();
  clearTimeout(howTimer); picking = false;
  liveState?.games.forEach((g) => { delete g.attemptsLeft; });
  gameAbort?.abort(); gameAbort = null; curIdle?.stop(); curIdle = null; howStop?.(); howStop = null; clearInterval(backTimer);
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

// ---------- local best (this screen only): drives "¡Superaste el puntaje!" on the result ----------
const readTop = () => { try { return JSON.parse(localStorage.getItem('fiesta.top')) || []; } catch { return []; } };
function saveTop(name, score) {
  const list = [...readTop(), { n: name, s: score }].sort((a, b) => b.s - a.s).slice(0, 3);
  try { localStorage.setItem('fiesta.top', JSON.stringify(list)); } catch {}
}

// ---------- attract leaderboards: the invitation and one board take turns every 8 s ----------
// Boards come from /api/live (server-built, display names only): overall first, then one per enabled game.
const SCENE_MS = 8000;
let sceneTimer = null, boardIdx = 0;
const boardSeen = new Map(); // board key -> row keys last shown, to highlight newcomers
function boardList() {
  const lb = liveState?.leaderboard;
  if (!lb) return [];
  return [{ key: 'all', title: 'Mejores puntajes generales', rows: lb.all },
    ...liveState.games.map((g) => ({ key: g.id, title: 'Mejores en ' + g.name, rows: lb.byGame?.[g.id] ?? [] }))];
}
const gameName = (id) => liveState?.games.find((g) => g.id === id)?.name ?? id;
function renderBoard(b) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });
  $('#board-title').textContent = b.title;
  const prev = boardSeen.get(b.key), keys = new Set();
  const rows = b.rows.map((r, i) => {
    const k = `${r.name}|${r.game}|${r.score}`;
    keys.add(k);
    const li = el('li', prev && !prev.has(k) ? 'new' : '');
    const chip = b.key === 'all' && el('span', 'chip', gameName(r.game));
    if (chip) chip.dataset.game = r.game;
    li.append(el('span', 'rk', String(i + 1)), el('span', 'nm', r.name), chip || '', el('span', 'sc', String(r.score)));
    return li;
  });
  boardSeen.set(b.key, keys);
  $('#board-rows').replaceChildren(...(rows.length ? rows : [el('li', 'empty', '¡Todavía nadie!\nSé el primero en aparecer aquí')]));
}
function nextScene() {
  const a = $('#attract');
  if (current !== 'attract') return;
  const list = boardList();
  if (a.classList.contains('show-board') || !list.length) a.classList.remove('show-board');
  else { renderBoard(list[boardIdx++ % list.length]); a.classList.add('show-board'); }
  sceneTimer = setTimeout(nextScene, SCENE_MS);
}
function stopScenes() { clearTimeout(sceneTimer); $('#attract').classList.remove('show-board'); }
function renderTops() { stopScenes(); boardIdx = 0; sceneTimer = setTimeout(nextScene, SCENE_MS); }

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

tap($('#attract'), () => { goFullscreen(); pin = ''; renderDots(); setMsg(''); stopScenes(); show('pin'); sfx.key(); });

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
    let d;
    try { d = await login(pin, screenId()); session = d.session; playerId = d.guestId; local = null; }
    catch (e) {
      if (!down(e)) throw e;
      d = await pinCheck(pin); // throws wrong_pin / locked / no_roster like the server would
      local = { offline: true, ...d }; session = null;
    }
    if (myGid !== gid) return;
    playerName = d.name;
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
  $('#avatar').innerHTML = mascot({ h: 350, shape: 'round', acc: 'hat' }) + '<b></b>';
  $('#avatar b').textContent = (fn[0] || '?').toUpperCase();
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
  await inflight; // re-poll with the session so attemptsLeft is known
  await poll();
  if (myGid !== gid) return;
  menuMsg(''); renderMenu(); show('menu');
}

// ---------- menu ----------
const tiles = $('#tiles');
const menuMsg = (t) => { $('#menumsg').textContent = t || ' '; };
// Offline: round games can't be played (their answer key lives on the server); an offline session counts attempts locally.
function menuGames() {
  let list = liveState?.games ?? (roster?.games ?? []).map(({ id, name, params }) => ({ id, name, params }));
  if (local || !netOk) list = list.filter((g) => !ROUND_GAMES.includes(g.id));
  return local ? list.map((g) => ({ ...g, attemptsLeft: attemptsLeft(roster, queue, local.guestId, g.id) })) : list;
}
function renderMenu() {
  const games = menuGames();
  tiles.replaceChildren();
  if (!games.length) {
    const d = document.createElement('div');
    d.className = 'none'; d.textContent = liveState ? 'No hay juegos disponibles ahora' : 'Sin conexión, reintentando…';
    tiles.append(d);
    return;
  }
  games.forEach((g, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = g.id;
    b.insertAdjacentHTML('afterbegin', mascot({ h: [350, 22, 38, 330][i % 4], shape: ['round', 'tall', 'box'][i % 3], acc: ['hat', 'bow', 'antenna'][i % 3] }));
    b.append(g.name);
    if (g.attemptsLeft === 0) { b.disabled = true; const s = document.createElement('small'); s.textContent = 'Ya jugaste'; b.append(s); }
    tiles.append(b);
  });
}
tap($('#menuexit'), toAttract);
tap(tiles, (e) => { const b = e.target.closest('button'); if (b && !b.disabled) pick(b.dataset.id); });

let picking = false;
async function pick(id) {
  if (picking) return;
  if (!GAME_MODULES[id]) return menuMsg('Este juego no está disponible ahora.');
  picking = true;
  const myGid = gid;
  try {
    let d;
    if (local) d = startLocalAttempt({ roster, queue, guestId: local.guestId, game: id });
    else {
      try { d = await startAttempt(session, id); bumpCount(roster, playerId, id); saveRoster(); }
      catch (e) { if (!down(e) || !roster) throw e; d = startLocalAttempt({ roster, queue, guestId: playerId, game: id }); } // server dropped mid-session
    }
    if (myGid !== gid) return;
    attempt = d; gameId = id;
    startHowto();
  } catch (e) {
    if (myGid !== gid) return;
    picking = false;
    menuMsg(e.code === 'max_attempts' ? 'Ya usaste tus intentos en este juego.' : e.code === 'game_unavailable' ? 'Este juego no está disponible ahora.' : 'No hay conexión. Inténtalo de nuevo.');
    await poll();
    if (myGid === gid && current === 'menu') renderMenu();
  }
}

// ---------- live state: poll + overlays ----------
let liveState = null, inflight = null, raffleOn = false, shownRaffle = null, raffleTimer, rSplit = null;
let clockOffset = 0; // server clock - local clock from the last poll (half the round trip as the estimate)
function poll() {
  if (inflight) return inflight;
  const t0 = Date.now();
  return (inflight = live({ screenId: screenId(), game: gameId || 'menu', session: session || undefined })
    .then((s) => { if (s.serverNow) clockOffset = s.serverNow - (t0 + Date.now()) / 2; liveState = s; netOk = true; showNet(); if (queue.items().length) flusher.kick(); if (current === 'menu') renderMenu(); applyOverlays(); scheduleCue(s); },
      () => { if (netOk) { netOk = false; if (current === 'menu') renderMenu(); } showNet(); }) // keep last good state
    .finally(() => { inflight = null; }));
}
// Every 1 s in raffle mode (so every panel sees a draw well before its show starts), otherwise every 5 s.
let ticks = 0;
setInterval(() => { if (liveState?.raffleMode || raffleOn || ++ticks % 5 === 0) poll(); }, 1000);

const setOv = (id, on) => { $(id).hidden = !on; };
const gone = (s) => !!gameId && !s.games.some((g) => g.id === gameId);
const blocked = () => !!liveState && (raffleOn || liveState.raffleMode || liveState.transition.on || liveState.paused || gone(liveState));
const showMsOf = (r) => Math.max(3, r.showSeconds || 15) * 1000;
// Priority raffle > raffle-mode plate > transition > pause. Nothing interrupts a running round; they show once it ends.
function applyOverlays() {
  const s = liveState;
  if (!s || raffleOn) return;
  const mid = current === 'game' || current === 'result';
  const rf = s.raffle;
  if (rf && rf.id !== shownRaffle && rafflePhase(Date.now(), clockOffset, rf.drawnAt, showMsOf(rf)).phase === 'done') shownRaffle = rf.id; // missed it
  if (!mid && rf && rf.id !== shownRaffle) return showRaffle(rf);
  const plate = !mid && !!s.raffleMode;
  setOv('#ov-plate', plate);
  const trans = !mid && !plate && s.transition.on;
  if (trans) $('#ttext').textContent = s.transition.text || 'Un momento…';
  setOv('#ov-trans', trans);
  const none = !mid && (s.paused || !s.games.length || gone(s));
  setOv('#ov-pause', none && !plate && !trans); // stays under the stage iframe: only visible while it loads
  stageIdle(none); // alive through plate/transition overlays (they sit above it), gone when games return
}

// Nothing to play (paused, or no game enabled): the panel shows the stage animations, 16:9 (stage.html?format=panel), following /api/live like the LED wall.
// The iframe is made when the idle starts and removed when games return. It shares localStorage (theme, ?api=) with this page; DOM order keeps it under the raffle/transition overlays.
const stageFrame = () => Object.assign(document.createElement('iframe'), { tabIndex: -1, title: 'Escenario',
  src: new URL('stage.html?format=panel&theme=' + (document.documentElement.classList.contains('noche') ? 'noche' : 'amanecer'), location.href).href });
let idleFrame = null;
function stageIdle(on) {
  if (!on) { idleFrame?.remove(); idleFrame = null; return; }
  if (idleFrame) return;
  idleFrame = Object.assign(stageFrame(), { id: 'ov-stage' });
  $('#ov-trans').before(idleFrame);
}
// Loaded once off-screen so the service worker caches the idle screen (page, fonts, art) before an internet drop.
function warmStage() {
  const f = stageFrame();
  f.style.cssText = 'position:absolute;left:-4000px;top:0;width:1920px;height:1080px;border:0;pointer-events:none';
  f.onload = () => setTimeout(() => f.remove(), 6000);
  document.body.append(f);
}

// Every panel runs the same timeline off the server clock (shared/raffle.js): wait -> ~8 s letter scramble -> winner -> back.
let raffleRaf;
function showRaffle(r) {
  shownRaffle = r.id; raffleOn = true;
  setOv('#ov-trans', false); setOv('#ov-pause', false); setOv('#ov-plate', false);
  rSplit?.revert(); rSplit = null; // revert first: it restores the previous winner's markup
  const name = cleanName(r.name), showMs = showMsOf(r), win = $('#rwin');
  $('#ov-raffle').className = 'overlay suspense';
  $('#rkick').textContent = 'Sorteando…'; $('#rcong').hidden = true;
  $('#rfprize').textContent = r.prize ? 'Premio: ' + r.prize : ''; $('#rfprize').hidden = !r.prize;
  win.textContent = RM ? '' : scramble(0, name, r.id);
  setOv('#ov-raffle', true);
  cancelAnimationFrame(raffleRaf); clearTimeout(raffleTimer);
  let last = -1;
  const frame = () => {
    const { phase, ms } = rafflePhase(Date.now(), clockOffset, r.drawnAt, showMs);
    if (phase === 'done') return endRaffle();
    if (phase === 'reveal') { revealRaffle(r.name); raffleTimer = setTimeout(endRaffle, showMs - ms); return; }
    if (phase === 'suspense' && !RM) {
      const step = Math.floor(ms / SCRAMBLE_MS);
      if (step !== last) { last = step; win.textContent = scramble(ms, name, r.id); if (step % 2 === 0) sfx.drum(); }
    }
    raffleRaf = requestAnimationFrame(frame);
  };
  frame();
}
function revealRaffle(name) {
  $('#ov-raffle').className = 'overlay reveal' + (RM ? ' fade' : '');
  $('#rkick').textContent = '¡Ganador!';
  $('#rwin').textContent = cleanName(name);
  $('#rcong').hidden = false;
  sfx.fan();
  if (RM) return;
  rSplit = SplitText.create('#rwin', { type: 'chars' });
  gsap.from('#rkick', { scale: 0.4, opacity: 0, duration: 0.5, ease: 'back.out(2)' });
  gsap.from(rSplit.chars, { scale: 0, y: 80, opacity: 0, duration: 0.6, ease: 'back.out(2.2)', stagger: 0.04, delay: 0.2 });
  gsap.from('#rcong', { opacity: 0, y: 30, duration: 0.5, delay: 1.1 });
  const shot = (x) => confetti({ particleCount: 90, spread: 100, startVelocity: 55, origin: { x, y: 0.6 }, zIndex: 100, disableForReducedMotion: true, colors: ['#FFC14D', '#FF8A3D', '#FF5A4D', '#FF2D8A', '#FFF7F3'] });
  shot(0.5);
  setTimeout(() => { shot(0.2); shot(0.8); }, 600);
  setTimeout(() => { shot(0.3); shot(0.7); }, 1400);
}
function endRaffle() {
  cancelAnimationFrame(raffleRaf); clearTimeout(raffleTimer);
  raffleOn = false; setOv('#ov-raffle', false); applyOverlays();
}

// ---------- how to ----------
function startHowto() {
  const { title, steps, art } = GAME_MODULES[gameId].howTo;
  $('#howtitle').textContent = title;
  $('#caps').replaceChildren(...steps.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  const artEl = $('#howart');
  artEl.replaceChildren(); artEl.hidden = !art;
  const ring = $('#howring');
  ring.style.animation = 'none'; void ring.getBoundingClientRect(); ring.style.animation = '';
  show('howto');

  const caps = [...document.querySelectorAll('#caps li')];
  howStop?.();
  howStop = art?.(artEl, (i) => caps.forEach((c, j) => c.classList.toggle('on', j === i))) ?? null;

  clearTimeout(howTimer);
  howTimer = setTimeout(startGame, HOWTO_MS);
}
let howTimer;
tap($('#start'), () => startGame());
tap($('#skip'), () => startGame());

// ---------- idle notice (ctx.idle for game modules) ----------
function makeIdle(params) {
  const idleMs = (params.idleSeconds ?? 20) * 1000, warnMs = (params.idleWarnSeconds ?? 5) * 1000;
  const ov = $('#ov-idle'), gameEl = $('#game');
  let timer, onTimeout = null;
  const arm = () => {
    clearTimeout(timer); ov.hidden = true;
    if (!onTimeout) return;
    timer = setTimeout(() => {
      ov.hidden = false;
      timer = setTimeout(() => { ov.hidden = true; const cb = onTimeout; onTimeout = null; cb(); }, warnMs);
    }, idleMs);
  };
  const idle = {
    start(cb) { onTimeout = cb; gameEl.addEventListener('pointerdown', arm, true); arm(); },
    bump: arm,
    stop() { clearTimeout(timer); onTimeout = null; ov.hidden = true; gameEl.removeEventListener('pointerdown', arm, true); },
  };
  return idle;
}

// ---------- game ----------
function countTo(el, from, to, dur) {
  const o = { v: from };
  gsap.to(o, { v: to, duration: dur, ease: 'power1.out', onUpdate: () => { el.textContent = Math.round(o.v); } });
}

async function startGame() {
  clearTimeout(howTimer);
  if (current !== 'howto' || !attempt) return;
  if (blocked()) { howTimer = setTimeout(startGame, 1000); return; }
  howStop?.(); howStop = null;
  const myGid = ++gid;
  const { attemptId, seed, offline } = attempt;
  const params = menuGames().find((g) => g.id === gameId)?.params ?? {};
  const ac = gameAbort = new AbortController();
  const idle = curIdle = makeIdle(params);
  show('game');
  let res;
  try {
    res = await GAME_MODULES[gameId].play($('#game'), { attemptId, session: local ? undefined : session, params, sfx, tap, rng: mulberry32(seed), idle, signal: ac.signal });
  } catch {
    if (!ac.signal.aborted) toAttract(); // module failure: back to the start
    return;
  } finally { idle.stop(); }
  if (myGid !== gid) return;
  const { score, durationMs } = res;
  // The result is queued first, so a dropped connection never loses it and the screen never waits on the network.
  queue.push({ kind: 'result', attemptId, score, durationMs, offline: !!offline });
  const answer = new Promise((r) => outcome.set(attemptId, r));
  flusher.kick();
  showResult(score, answer);
}

// ---------- result ----------
function showResult(score, answer) {
  const prevBest = readTop()[0]?.s;
  const record = prevBest !== undefined && score > prevBest;
  saveTop(firstName(playerName), score);
  $('#rtitle').textContent = score > 70 ? '¡Increíble!' : score >= 40 ? '¡Muy bien!' : '¡Buen intento!';
  $('#rscore').textContent = '0';
  $('#rnote').textContent = ' ';
  $('#record').hidden = !record;
  $('#rprize').hidden = true; $('#rpending').hidden = true; $('#thanks').hidden = false;
  show('result');
  sfx.fan();
  gsap.from('#medal', { y: -900, duration: 0.9, ease: 'bounce.out' });
  gsap.from('#rtitle', { scale: 0.5, opacity: 0, duration: 0.5, ease: 'back.out(2)', delay: 0.2 });
  countTo($('#rscore'), 0, score, 1.2);
  if (record) gsap.from('#record', { scale: 0, rotation: -20, duration: 0.5, ease: 'back.out(2.5)', delay: 1.1 });
  confetti({ particleCount: score > 70 ? 80 : 60, spread: 100, startVelocity: 45, origin: { y: 0.55 }, disableForReducedMotion: true, zIndex: 100, colors: ['#FFC14D', '#FF8A3D', '#FF5A4D', '#FF2D8A', '#FFF7F3'] });

  const myGid = gid, threshold = roster?.games.find((g) => g.id === gameId)?.threshold;
  const counted = wait(1200); // let the score count up first
  const reveal = (el) => {
    if (myGid !== gid || current !== 'result') return;
    $('#thanks').hidden = true; el.hidden = false;
    if (!RM) gsap.from(el, { scale: 0.5, opacity: 0, duration: 0.6, ease: 'back.out(2)' });
  };
  let answered = false;
  answer.then(async (won) => { answered = true; if (won) { await counted; $('#rpending').hidden = true; reveal($('#rprize')); } });
  // No answer in time (offline / slow): never award locally, just tell them to ask at the desk if they cleared the threshold.
  wait(2000).then(() => { if (!answered && threshold !== undefined && score >= threshold) reveal($('#rpending')); });
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

// ---------- WOW cue: this panel's part of one gold sweep that travels panel 1 -> 4 and lands on the stage screen ----------
// ?panel=1..4 (remembered) is this panel's place in the row; unset panels sweep with panel 1. Overlay only: never interrupts a game.
const panelSlot = (() => {
  const p = Number(new URLSearchParams(location.search).get('panel'));
  try { if (p >= 1 && p <= PANELS) localStorage.setItem('fiesta.panel', String(p)); return Number(localStorage.getItem('fiesta.panel')) || 1; } catch { return p || 1; }
})();
let cueSeen = 0;
function scheduleCue(s) {
  const at = s.stage?.cueAt;
  if (!at || at === cueSeen) return;
  cueSeen = at;
  const ms = cueMs(Date.now(), clockOffset, at, panelSlot);
  if (ms < 0) setTimeout(playCue, -ms); // missed it (late poll): skip
}
function playCue() {
  const ov = $('#ov-cue'), total = CUE_SWEEP_MS + 500;
  ov.hidden = false;
  ov.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: total });
  if (!RM) ov.firstElementChild.animate([{ transform: 'translateX(-800px) skewX(-18deg)' }, { transform: 'translateX(2100px) skewX(-18deg)' }], { duration: CUE_SWEEP_MS, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'both' });
  setTimeout(() => { ov.hidden = true; }, total);
}

show('attract');
renderTops();
poll();

// ---------- service worker (server mode, production only): caches the panel's own files for offline reloads ----------
if (!isDemo && import.meta.env.PROD && 'serviceWorker' in navigator) {
  // The first load happened before the worker controlled the page: hand it the URLs this page already used.
  const precache = (reg) => { reg.active?.postMessage({ precache: [location.href, ...performance.getEntriesByType('resource').map((r) => r.name)] }); warmStage(); };
  navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').then(() => navigator.serviceWorker.ready).then((reg) => {
    if (document.readyState === 'complete') precache(reg); else addEventListener('load', () => precache(reg));
  }).catch(() => {});
}
