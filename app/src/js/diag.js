const $ = (s) => document.querySelector(s);
const cv = $('#c'), ctx = cv.getContext('2d');
const active = new Map(); // id -> {type, x, y, pressure, w, h, trail}
const done = []; // finished trails
let max = 0;
const COLORS = { touch: '#FFC14D', pen: '#6ee7ff', mouse: '#ff8a8a' };

function resize() {
  const d = devicePixelRatio || 1;
  cv.width = innerWidth * d; cv.height = innerHeight * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  placeTargets(); fillEnv();
}

// Tap-accuracy targets: 4 corners, 4 edges, center
const targets = [];
function placeTargets() {
  for (const t of targets) t.el.remove();
  targets.length = 0;
  const m = 48, W = innerWidth, H = innerHeight;
  for (const [x, y] of [[m, m], [W / 2, m], [W - m, m], [m, H / 2], [W / 2, H / 2 + 110], [W - m, H / 2], [m, H - m], [W / 2, H - m], [W - m, H - m]]) {
    const el = document.createElement('div');
    el.className = 't'; el.style.left = x + 'px'; el.style.top = y + 'px'; el.textContent = 'toca';
    document.body.append(el);
    targets.push({ el, x, y });
  }
}

function fillEnv() {
  const rows = [
    ['screen', `${screen.width}x${screen.height}`],
    ['inner', `${innerWidth}x${innerHeight}`],
    ['devicePixelRatio', devicePixelRatio],
    ['maxTouchPoints', navigator.maxTouchPoints],
    ['Pointer Events', 'PointerEvent' in window ? 'sí' : 'NO'],
    ['Fullscreen', document.documentElement.requestFullscreen ? 'sí' : 'NO'],
    ['user agent', navigator.userAgent],
  ];
  $('#env').innerHTML = rows.map(([k, v]) => `<div><b>${k}</b>: ${v}</div>`).join('');
}

function update(e) {
  const p = active.get(e.pointerId) ?? { trail: [] };
  Object.assign(p, { type: e.pointerType, x: e.clientX, y: e.clientY, pressure: e.pressure, w: e.width, h: e.height });
  p.trail.push([e.clientX, e.clientY]);
  active.set(e.pointerId, p);
  max = Math.max(max, active.size);
  $('#maxn').textContent = max;
}

addEventListener('pointerdown', (e) => {
  update(e);
  for (const t of targets) {
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (Math.hypot(dx, dy) < 60) {
      const hit = Math.hypot(dx, dy) <= 32;
      t.el.className = 't ' + (hit ? 'hit' : 'miss');
      t.el.textContent = `${dx >= 0 ? '+' : ''}${Math.round(dx)}, ${dy >= 0 ? '+' : ''}${Math.round(dy)}`;
    }
  }
});
addEventListener('pointermove', update);
for (const ev of ['pointerup', 'pointercancel']) {
  addEventListener(ev, (e) => {
    const p = active.get(e.pointerId);
    if (p) { done.push({ type: p.type, trail: p.trail }); active.delete(e.pointerId); if (done.length > 200) done.shift(); }
  });
}
for (const ev of ['contextmenu', 'gesturestart', 'selectstart']) addEventListener(ev, (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

$('#clear').addEventListener('click', () => {
  done.length = 0;
  max = active.size; $('#maxn').textContent = max;
  for (const t of targets) { t.el.className = 't'; t.el.textContent = 'toca'; }
});

function path(trail) {
  ctx.beginPath();
  trail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function frame() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.globalAlpha = .45;
  for (const d of done) { ctx.strokeStyle = COLORS[d.type] ?? '#fff'; path(d.trail); }
  ctx.globalAlpha = 1;
  ctx.font = '600 14px Outfit, sans-serif';
  const lines = [];
  for (const [id, p] of active) {
    const col = COLORS[p.type] ?? '#fff';
    ctx.strokeStyle = col; path(p.trail);
    const r = Math.max(24, Math.max(p.w, p.h) / 2);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillText(`#${id} ${p.type} p=${p.pressure.toFixed(2)} ${Math.round(p.w)}x${Math.round(p.h)}`, p.x + r + 8, p.y - 8);
    lines.push(`#${id} ${p.type} p=${p.pressure.toFixed(2)} ${Math.round(p.w)}x${Math.round(p.h)}`);
  }
  $('#live').textContent = lines.length ? lines.join(' | ') : 'Sin punteros activos';
  requestAnimationFrame(frame);
}

addEventListener('resize', resize);
resize();
frame();
