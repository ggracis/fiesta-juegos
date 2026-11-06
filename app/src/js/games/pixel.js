import gsap from 'gsap';
import { rounds as fetchRounds, answer as postAnswer } from '../api.js';
import { pixelTotal } from '../../shared/scoring.js';
import { $, RM } from '../common.js';
import '../../css/pixel.css';

const STEPS = [8, 12, 18, 28, 44, 70, 0]; // blocks across the width; 0 = full image
const FEEDBACK_MS = 1200;
const BOX_W = 960, BOX_H = 600; // canvas area; the canvas takes the image's aspect inside it

// Pages demo: the static API returns bare file names, so the placeholders are bundled here.
// The condition is constant at build time, so the server build drops the glob and ships no demo images.
const DEMO_IMAGES = import.meta.env.VITE_DATA_MODE === 'static'
  ? import.meta.glob('../../../data/content/pixel/*.jpg', { query: '?url', import: 'default' })
  : {};

const abortError = () => new DOMException('aborted', 'AbortError');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const abort = () => { clearTimeout(t); reject(abortError()); };
    const t = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Network errors retry after 1, 2 and 4 s (like finishWithRetry); anything else throws at once.
async function retry(fn, signal) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (e.code !== 'network' || i === 3 || signal.aborted) throw e; await sleep(1000 * 2 ** i, signal); }
  }
}

async function loadImage(file) {
  const bundled = DEMO_IMAGES[`../../../data/content/pixel/${file.split('/').pop()}`];
  const img = new Image();
  img.src = bundled ? await bundled() : file;
  await img.decode().catch(() => {}); // a broken image stays blank; the round still plays
  return img;
}

// Native pixelation: draw at `n` px wide, scale back up with smoothing off. n = 0 draws the full image.
const small = document.createElement('canvas');
function draw(cv, img, n) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (!(img.naturalWidth ?? img.width)) return;
  if (!n) { g.imageSmoothingEnabled = true; g.drawImage(img, 0, 0, cv.width, cv.height); return; }
  small.width = n; small.height = Math.max(1, Math.round((n * cv.height) / cv.width));
  const s = small.getContext('2d');
  s.imageSmoothingQuality = 'high';
  s.drawImage(img, 0, 0, small.width, small.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, cv.width, cv.height);
}

function fitCanvas(cv, img) {
  const r = img.naturalWidth / img.naturalHeight || BOX_W / BOX_H;
  [cv.width, cv.height] = r > BOX_W / BOX_H ? [BOX_W, Math.round(BOX_W / r)] : [Math.round(BOX_H * r), BOX_H];
}

function mount(root, tap) {
  root.dataset.game = 'pixel';
  const view = document.createElement('div');
  view.className = 'px';
  view.innerHTML = '<div class="px-frame"><canvas aria-hidden="true"></canvas><p class="px-msg" role="status"></p></div>'
    + `<div class="px-opts">${'<button type="button"></button>'.repeat(4)}</div>`;
  root.append(view);
  const ui = { view, cv: $('canvas', view), msg: $('.px-msg', view), opts: $('.px-opts', view), onPick: null, tw: null };
  ui.buttons = [...ui.opts.children];
  ui.buttons.forEach((b, i) => { b.dataset.i = i; });
  tap(ui.opts, (e) => { const b = e.target.closest('button'); if (b && ui.onPick) ui.onPick(+b.dataset.i); });
  return ui;
}

function say(ui, text, kind = '') {
  ui.msg.textContent = text;
  ui.msg.className = 'px-msg ' + kind;
  if (text && !RM) gsap.fromTo(ui.msg, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(2)' });
}

async function playRound(round, img, index, ctx, ui, signal) {
  const revealMs = (Number(ctx.params.revealSeconds) || 10) * 1000;
  const bar = $('#timebar', ctx.root), num = $('#timenum', ctx.root);
  fitCanvas(ui.cv, img);
  draw(ui.cv, img, STEPS[0]);
  say(ui, '');
  ui.opts.classList.remove('done');
  ui.buttons.forEach((b, i) => { b.className = ''; b.textContent = round.options[i] ?? ''; });
  bar.classList.remove('hurry'); num.classList.remove('hurry');
  gsap.set(bar, { clearProps: 'backgroundColor', scaleX: 1 });
  ui.tw = gsap.to(bar, {
    scaleX: 0, duration: revealMs / 1000, ease: 'none',
    onUpdate() {
      const left = Math.ceil((revealMs / 1000) * (1 - this.progress()));
      num.textContent = left;
      if (left <= 3) { bar.classList.add('hurry'); num.classList.add('hurry'); }
    },
  });
  const start = performance.now();

  const choice = await new Promise((resolve, reject) => {
    const timers = STEPS.slice(1).map((n, k) => setTimeout(() => draw(ui.cv, img, n), ((k + 1) * revealMs) / STEPS.length));
    const end = () => { timers.forEach(clearTimeout); clearTimeout(timeout); ui.onPick = null; signal.removeEventListener('abort', abort); };
    const abort = () => { end(); reject(abortError()); };
    const timeout = setTimeout(() => { end(); resolve(null); }, revealMs);
    signal.addEventListener('abort', abort, { once: true });
    ui.onPick = (c) => { end(); resolve(c); };
  });
  const ms = Math.min(revealMs, Math.round(performance.now() - start));
  ui.tw.kill();
  bar.classList.remove('hurry'); num.classList.remove('hurry');
  draw(ui.cv, img, 0);
  ui.opts.classList.add('done');
  if (choice !== null) ui.buttons[choice].classList.add('picked');

  let res = null;
  try { res = await retry(() => postAnswer(ctx.attemptId, ctx.session, index, choice, ms), signal); }
  catch (e) { if (signal.aborted) throw e; }
  if (!res) say(ui, 'Sin conexión', 'bad');
  else {
    ui.buttons[res.correctChoice]?.classList.add('ok');
    if (res.correct) { ctx.sfx.good(); say(ui, `+${res.points}`, 'good'); }
    else {
      ctx.sfx.bad();
      if (choice !== null) ui.buttons[choice].classList.add('bad');
      say(ui, choice === null ? 'Se acabó el tiempo' : 'Incorrecto', 'bad');
    }
  }
  await sleep(FEEDBACK_MS, signal);
  return { correct: !!res?.correct, points: res?.points ?? 0 };
}

async function play(root, ctx) {
  const t0 = performance.now();
  const stop = new AbortController(); // the panel left the game, or the player walked away
  const quit = () => stop.abort();
  ctx.signal.addEventListener('abort', quit, { once: true });
  ctx.idle.start(quit);
  const ui = mount(root, ctx.tap);
  const pips = $('#pips', root), scorenum = $('#scorenum', root);
  const results = [];
  let total = 0;
  scorenum.textContent = '0';
  try {
    const { rounds } = await retry(() => fetchRounds(ctx.attemptId, ctx.session), stop.signal);
    total = rounds.length;
    pips.innerHTML = '<i></i>'.repeat(total);
    const images = rounds.map((r) => loadImage(r.image)); // all load in the background
    for (let i = 0; i < total; i++) {
      const img = await images[i];
      if (stop.signal.aborted) throw abortError();
      pips.children[i].className = 'cur';
      const res = await playRound(rounds[i], img, i, { ...ctx, root }, ui, stop.signal);
      results.push(res);
      pips.children[i].className = res.correct ? 'ok' : 'miss';
      scorenum.textContent = pixelTotal(results, total);
    }
  } catch (e) {
    if (ctx.signal.aborted || !stop.signal.aborted) throw e; // left the game, or a real failure: play.js handles it
    // idle timeout: unanswered rounds score 0, the game ends with the score so far
  } finally {
    ui.tw?.kill();
    ctx.idle.stop();
    ctx.signal.removeEventListener('abort', quit);
    ui.view.remove();
    delete root.dataset.game;
  }
  return { score: pixelTotal(results, total), durationMs: Math.round(performance.now() - t0) };
}

// How-to illustration: a simple scene that sharpens step by step, then the right option lights up.
function art(el, setStep) {
  el.innerHTML = '<div class="px-demo"><canvas width="480" height="300"></canvas><div class="px-chips"><i></i><i></i><i></i><i></i></div></div>';
  const cv = $('canvas', el), chips = [...el.querySelectorAll('.px-chips i')];
  const scene = document.createElement('canvas');
  scene.width = 480; scene.height = 300;
  const g = scene.getContext('2d');
  g.fillStyle = '#7EC8F0'; g.fillRect(0, 0, 480, 300);
  g.fillStyle = '#FFD23F'; g.beginPath(); g.arc(360, 90, 52, 0, 7); g.fill();
  g.fillStyle = '#3E8E41'; g.beginPath(); g.ellipse(170, 330, 280, 130, 0, 0, 7); g.fill();
  let k = 0;
  const tick = () => {
    const step = k % 10;
    if (step < STEPS.length) draw(cv, scene, STEPS[step]);
    setStep(step < 2 ? 0 : step < 6 ? 1 : 2);
    chips.forEach((c, i) => c.classList.toggle('on', step >= 6 && i === 1));
    k++;
  };
  tick();
  const timer = setInterval(tick, 700);
  return () => clearInterval(timer);
}

export default {
  id: 'pixel',
  howTo: { title: 'Así se juega', steps: ['Mira', 'Adivina', 'Toca'], art },
  play,
};
