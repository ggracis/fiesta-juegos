import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import confetti from 'canvas-confetti';
import { login, startAttempt, finishAttempt, live, screenId } from './api.js';
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

// ---------- screens + idle ----------
const screens = [...document.querySelectorAll('.screen')];
let current = 'attract', idleTimer, gid = 0, session = null, attempt = null, playerName = '';
let gameId = null, howStop = null, gameAbort = null, curIdle = null, topsTl = null, backTimer = null, holaSplit = null;

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
  gid++; session = null; attempt = null; gameId = null; pin = ''; renderDots();
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
  box.replaceChildren(document.createElement('span'), document.createElement('span'));
  box.children[0].textContent = 'Mejores puntajes de esta pantalla';
  top.forEach((t, i) => {
    const el = document.createElement('i'), b = document.createElement('b');
    el.style.fontStyle = 'normal'; b.textContent = t.s;
    el.append(`${i + 1}. ${t.n} `, b);
    box.children[1].append(el);
  });
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
function renderMenu() {
  const games = liveState?.games ?? [];
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
    const d = await startAttempt(session, id);
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
function poll() {
  if (inflight) return inflight;
  return (inflight = live({ screenId: screenId(), game: gameId || 'menu', session: session || undefined })
    .then((s) => { liveState = s; if (current === 'menu') renderMenu(); applyOverlays(); })
    .catch(() => {}) // keep last good state
    .finally(() => { inflight = null; }));
}
setInterval(poll, 5000);

const setOv = (id, on) => { $(id).hidden = !on; };
const gone = (s) => !!gameId && !s.games.some((g) => g.id === gameId);
const blocked = () => !!liveState && (raffleOn || liveState.transition.on || liveState.paused || gone(liveState));
// Priority raffle > transition > pause. Nothing interrupts a running round; they show once it ends.
function applyOverlays() {
  const s = liveState;
  if (!s || raffleOn) return;
  const mid = current === 'game' || current === 'result';
  const rf = s.raffle;
  if (rf && rf.id !== shownRaffle && Date.now() - rf.drawnAt > (rf.showSeconds + 10) * 1000) shownRaffle = rf.id; // stale
  if (!mid && rf && rf.id !== shownRaffle) return showRaffle(rf);
  const trans = !mid && s.transition.on;
  if (trans) $('#ttext').textContent = s.transition.text || 'Un momento…';
  setOv('#ov-trans', trans);
  setOv('#ov-pause', !mid && !trans && (s.paused || gone(s)));
}

function showRaffle(r) {
  shownRaffle = r.id; raffleOn = true;
  setOv('#ov-trans', false); setOv('#ov-pause', false);
  rSplit?.revert(); rSplit = null; // revert first: it restores the previous winner's markup
  $('#rwin').textContent = cleanName(r.name);
  setOv('#ov-raffle', true);
  if (!RM) {
    rSplit = SplitText.create('#rwin', { type: 'chars' });
    gsap.from('#rkick', { scale: 0.4, opacity: 0, duration: 0.5, ease: 'back.out(2)' });
    gsap.from(rSplit.chars, { scale: 0, y: 80, opacity: 0, duration: 0.6, ease: 'back.out(2.2)', stagger: 0.04, delay: 0.5 });
    gsap.from('#rcong', { opacity: 0, y: 30, duration: 0.5, delay: 1.4 });
    const shot = (x) => confetti({ particleCount: 90, spread: 100, startVelocity: 55, origin: { x, y: 0.6 }, zIndex: 100, disableForReducedMotion: true, colors: ['#FFC14D', '#FF8A3D', '#FF5A4D', '#FF2D8A', '#FFF7F3'] });
    setTimeout(() => { shot(0.2); shot(0.8); }, 900);
    setTimeout(() => { shot(0.3); shot(0.7); }, 1700);
  }
  clearTimeout(raffleTimer);
  raffleTimer = setTimeout(() => { raffleOn = false; setOv('#ov-raffle', false); applyOverlays(); }, Math.max(3, r.showSeconds || 15) * 1000);
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

async function finishWithRetry(id, score, ms) {
  for (let i = 0; ; i++) {
    try { return await finishAttempt(id, score, ms); }
    catch (e) { if (e.code !== 'network' || i === 3) throw e; await wait(1000 * 2 ** i); } // 1 s, 2 s, 4 s
  }
}

async function startGame() {
  clearTimeout(howTimer);
  if (current !== 'howto' || !attempt) return;
  if (blocked()) { howTimer = setTimeout(startGame, 1000); return; }
  howStop?.(); howStop = null;
  const myGid = ++gid;
  const { attemptId, seed } = attempt;
  const params = liveState?.games.find((g) => g.id === gameId)?.params ?? {};
  const ac = gameAbort = new AbortController();
  const idle = curIdle = makeIdle(params);
  show('game');
  let res;
  try {
    res = await GAME_MODULES[gameId].play($('#game'), { attemptId, session, params, sfx, tap, rng: mulberry32(seed), idle, signal: ac.signal });
  } catch {
    if (!ac.signal.aborted) toAttract(); // module failure: back to the start
    return;
  } finally { idle.stop(); }
  if (myGid !== gid) return;
  const { score, durationMs } = res;
  let note = '', prize = false;
  try { prize = (await finishWithRetry(attemptId, score, durationMs)).prizeWon; } catch { note = 'No se pudo guardar el resultado.'; }
  if (myGid !== gid) return;
  showResult(score, note, prize);
}

// ---------- result ----------
function showResult(score, note, prize) {
  const prevBest = readTop()[0]?.s;
  const record = prevBest !== undefined && score > prevBest;
  saveTop(firstName(playerName), score);
  $('#rtitle').textContent = score > 70 ? '¡Increíble!' : score >= 40 ? '¡Muy bien!' : '¡Buen intento!';
  $('#rscore').textContent = '0';
  $('#rnote').textContent = note || ' ';
  $('#record').hidden = !record;
  $('#rprize').hidden = !prize; $('#thanks').hidden = !!prize;
  show('result');
  sfx.fan();
  gsap.from('#medal', { y: -900, duration: 0.9, ease: 'bounce.out' });
  gsap.from('#rtitle', { scale: 0.5, opacity: 0, duration: 0.5, ease: 'back.out(2)', delay: 0.2 });
  countTo($('#rscore'), 0, score, 1.2);
  if (prize && !RM) gsap.from('#rprize', { scale: 0.5, opacity: 0, duration: 0.6, ease: 'back.out(2)', delay: 1.2 });
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
poll();
