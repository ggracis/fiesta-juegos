import * as api from './api.js';
import { gameById, PARAM_INFO } from '../shared/games.js';

const $ = (id) => document.getElementById(id);
// DOM builder: strings become text nodes, so server data is never parsed as HTML.
const h = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.flat().filter((k) => k != null && k !== false));
  return n;
};
const clear = (n) => n.replaceChildren();
// True when `v` differs from what was last rendered under `k`: polled views skip identical payloads so nodes under a finger are never replaced.
const seen = {};
const changed = (k, v) => { const j = JSON.stringify(v); return seen[k] !== j && ((seen[k] = j), true); };

const ERRORS = {
  wrong_password: 'Contraseña incorrecta.', rate_limited: 'Demasiados intentos. Espera un minuto.',
  admin_disabled: 'El panel no está habilitado en el servidor.', network: 'Sin conexión con el servidor.',
  not_registered: 'Ese invitado todavía no confirmó su asistencia.', no_candidates: 'No quedan invitados acreditados para sortear.',
  unknown_game: 'Juego desconocido.', not_found: 'No encontrado.', csv_required: 'Selecciona un archivo CSV.',
  guest_exists: 'Ya existe un invitado con ese nombre: búscalo en la lista.',
  already_resolved: 'Esa verificación ya fue resuelta.', http: 'Error del servidor.', already_checked_in: 'Ya estaba acreditado.', demo_unavailable: 'No disponible en el modo demo.',
};
let toastTimer;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
// Runs fn, shows errors as a toast; 401 sends the user back to login. Returns undefined on failure.
// A lost connection raises one sticky banner (cleared by the next call that gets through) instead of a toast per poll.
async function run(fn) {
  try { const r = await fn(); $('netbar').hidden = true; return r; } catch (e) {
    $('netbar').hidden = e.code !== 'network';
    if (e.code === 'network') return;
    if (e.code === 'unauthorized') { toast('Sesión vencida', true); showLogin(); }
    else if (e.status === 413) toast('El archivo es demasiado grande (máx. 1 MB).', true);
    else if (e.status === 400) toast('Datos inválidos.', true);
    else toast(ERRORS[e.code] || 'Ocurrió un error inesperado.', true);
  }
}

// `next` is honoured only for same-origin relative URLs.
function safeNext() {
  const n = new URLSearchParams(location.search).get('next') || '';
  if (!n) return null; // no ?next=: stay here (new URL('') is this page, which reloaded in a loop)
  try {
    const u = new URL(n, location.href);
    return u.origin === location.origin && !/[\\\t\r\n]/.test(n) ? u.pathname + u.search + u.hash : null;
  } catch { return null; }
}

let S = null; // last admin state
const TABS = [['guests', 'Puerta'], ['stage', 'Escenario'], ['live', 'Paneles'], ['games', 'Juegos'], ['results', 'Resultados'], ['setup', 'Preparación']];

// Dark by default (venue lighting); the choice is remembered per device.
function setTheme(dark) {
  document.body.classList.toggle('dark', dark);
  $('theme').textContent = dark ? 'Modo claro' : 'Modo oscuro';
  try { localStorage.setItem('fiesta.admin.dark', dark ? '1' : '0'); } catch {}
}

function showLogin() {
  $('app').hidden = true; $('login').hidden = false; $('pw').value = ''; $('pw').focus();
}
function enter() {
  const next = safeNext();
  if (next) { location.replace(next); return; }
  $('login').hidden = true; $('app').hidden = false;
  let tab;
  try { tab = localStorage.getItem('fiesta.admin.tab'); } catch {}
  select(TABS.some(([k]) => k === tab) ? tab : TABS[0][0]); // a tab id saved by an older layout falls back to the first tab
}

async function refresh() {
  const s = await run(api.adminState);
  if (s) {
    S = s;
    const n = $('verif-count');
    n.textContent = s.pendingVerifications; n.hidden = !s.pendingVerifications;
    renderStrip();
  }
  return s;
}

// Always-visible status line: what an operator must know before touching anything.
function renderStrip() {
  if (!S) return;
  const { settings: st, prizes: p } = S;
  $('strip').textContent = `Pausa: ${st.paused ? 'sí' : 'no'} · Modo sorteo: ${st.raffleMode ? 'sí' : 'no'} · LED: ${ST ? SCENE_LABELS[ST.scene] : '—'} · Premios: quedan ${p.left}`;
  $('strip').className = 'strip' + (p.left <= 0 ? ' bad' : st.paused || p.left <= 5 ? ' warn' : '');
}

// One poll for every tab: the badge and the strip stay current everywhere.
let polling = false;
async function poll() {
  if (polling || document.hidden || $('app').hidden) return;
  polling = true;
  try {
    const [s, st] = await Promise.all([refresh(), current === 'stage' ? null : run(api.adminStage)]); // Escenario polls itself every 3 s
    if (st) ST = st;
    if (!s) return;
    renderStrip();
    if (current === 'live') renderLive();
    if (current === 'guests') checkVerifs();
  } finally { polling = false; }
}
setInterval(poll, 8000);

let current;
async function select(tab) {
  current = tab;
  try { localStorage.setItem('fiesta.admin.tab', tab); } catch {}
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('tabs').querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  for (const [k] of TABS) $('t-' + k).hidden = k !== tab;
  if (!(await refresh()) || current !== tab) return;
  if (!ST && tab !== 'stage') run(api.adminStage).then((st) => { if (st) { ST = st; renderStrip(); } }); // LED scene for the strip
  ({
    guests: () => { loadVerifs(); loadGuests(); }, live: renderLive, games: () => { renderStock(); renderGames(); }, results: renderResults,
    stage: () => { const pv = $('st-preview'); if (!pv.getAttribute('src')) pv.src = new URL('stage.html', location.href).href + '?preview=1'; loadStage(); loadRaffle(); },
    setup: () => { renderContent(); loadStage(true); },
  })[tab]();
}

// ---- Paneles
const setting = (patch) => run(() => api.adminSettings(patch)).then((r) => { if (r) { Object.assign(S.settings, r); renderLive(); renderStrip(); } return r; });
const saveGame = (id, patch) => run(() => api.adminGame(id, patch)).then(async (g) => { if (g) await refresh(); return g; });

function renderLive() {
  const { settings, games, screens } = S;
  $('paused').checked = settings.paused;
  $('trans').checked = settings.transition;
  if (document.activeElement !== $('trans-text')) $('trans-text').value = settings.transitionText;
  const box = $('live-games');
  if (changed('live', games.map((g) => [g.id, g.name, g.ready]))) {
    clear(box);
    for (const g of games) {
      const cb = h('input', { type: 'checkbox' });
      cb.dataset.id = g.id;
      cb.onchange = () => { cb.dataset.busy = '1'; saveGame(g.id, { enabled: cb.checked }).then(() => { delete cb.dataset.busy; renderLive(); }); };
      box.append(h('label', { className: 'sw' }, cb, h('span', {}, g.name + (g.ready ? '' : ' (próximamente)'))));
    }
  }
  for (const cb of box.querySelectorAll('input')) { // patched in place: a poll never replaces the box being tapped
    const g = games.find((x) => x.id === cb.dataset.id);
    cb.disabled = !g.ready;
    if (!cb.dataset.busy) cb.checked = g.enabled;
  }
  const n = S.prizes.left;
  $('left-note').textContent = n === 1 ? 'Queda 1 premio.' : `Quedan ${n} premios.`;
  const body = $('screens'); clear(body);
  const now = Date.now();
  for (const s of screens) {
    body.append(h('tr', {}, h('td', {}, s.id.slice(0, 8)), h('td', {}, s.game),
      h('td', {}, `hace ${Math.max(0, Math.round((now - s.lastSeen) / 1000))} s`),
      h('td', {}, h('span', { className: 'dot' + (s.online ? ' on' : '') }), s.online ? 'En línea' : 'Sin señal')));
  }
  $('screens-empty').hidden = screens.length > 0;
}

// ---- Puerta
const time = (ms) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
let gTimer;
const ticketUrl = (token) => new URL('ticket.html?t=' + encodeURIComponent(token), location.href).href;
const ticketLink = (token) => h('a', { className: 'b primary', href: ticketUrl(token), target: '_blank', rel: 'noopener' }, 'Abrir ticket (QR y PIN)');

// PIN in plain sight: staff read it to the guest at the door.
const pinBox = (pin) => h('div', { className: 'pinrow' }, h('span', { className: 'muted' }, 'PIN'), h('code', { className: 'pin' }, pin));

// Door mode: search, filter chips, one big card per guest with the action that fits its state.
const FILTER_LABELS = [['all', 'Todos'], ['unaccredited', 'Sin acreditar'], ['accredited', 'Acreditados'], ['unconfirmed', 'No confirmados'], ['walkIn', 'Agregados en puerta']];
let gFilter = 'unaccredited', gSeq = 0, lastAct = '', down = false;
// Background refreshes never replace cards while a finger or mouse button is down.
addEventListener('pointerdown', () => { down = true; }, true);
for (const t of ['pointerup', 'pointercancel']) addEventListener(t, () => { down = false; }, true);
const fmtDni = (d) => String(d ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
async function loadGuests(bg) {
  const seq = bg ? gSeq : ++gSeq; // a user-triggered load (search, filter) supersedes any load still in flight
  const q = $('gq').value.trim();
  const res = await run(() => api.adminGuests(q, gFilter));
  if (!res || seq !== gSeq || (bg && down)) return;
  if (!changed('g', res) && bg) return;
  const { guests, counts, summary } = res;
  const y = scrollY; // refreshes must not move the list under the staff's finger
  $('gfilters').replaceChildren(...FILTER_LABELS.map(([k, label]) => {
    const b = h('button', { type: 'button', className: 'chip', ariaPressed: String(k === gFilter) }, `${label} · ${counts[k]}`);
    b.onclick = () => { gFilter = k; loadGuests(); };
    return b;
  }));
  $('gsum').replaceChildren(`${summary.total} invitados · ${summary.confirmed} confirmados · ${summary.accredited} acreditados`,
    lastAct && h('span', { className: 'last' }, 'Última acción: ' + lastAct));
  $('guests').replaceChildren(...guests.map(guestCard));
  $('guests-empty').hidden = guests.length > 0;
  $('guests-empty-t').textContent = 'Sin resultados.' + (gFilter === 'all' ? '' : ' Prueba con el filtro «Todos».');
  $('ag-from-q').hidden = !q; $('ag-from-q').textContent = `Agregar «${q}»`;
  scrollTo(0, y);
}
function guestCard(g) {
  const chip = (text, cls = '') => h('span', { className: 'badge ' + cls }, text);
  let act;
  if (g.checkedInAt) act = ticketLink(g.ticketToken);
  else if (g.registered) {
    act = h('button', { className: 'b primary', type: 'button' }, 'Acreditar'); // no confirm: speed at the door matters
    act.onclick = async (ev) => {
      ev.stopPropagation();
      if (await run(() => api.adminCheckinGuest(g.id))) { lastAct = `${g.name} acreditado ${time(Date.now())}`; toast(`${g.name} acreditado`); loadGuests(); }
    };
  } else {
    act = h('button', { className: 'b primary', type: 'button' }, 'Acreditar y dar entrada');
    act.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`¿Acreditar a ${g.name}? No había confirmado asistencia.`)) return;
      const r = await run(() => api.adminWalkIn(g.id));
      if (r) { lastAct = `${g.name} acreditado ${time(Date.now())}`; toast(`${g.name} acreditado · PIN ${r.pin}`); loadGuests(); } // the refreshed card shows the PIN and ticket
    };
  }
  const card = h('article', { className: 'card guest' },
    h('div', { className: 'gtop' }, h('strong', {}, g.name),
      g.checkedInAt ? chip('Acreditado ✓ ' + time(g.checkedInAt), 'ok') : chip(g.registered ? 'Confirmado' : 'No confirmado', g.registered ? 'ok' : ''),
      g.walkIn && chip('Agregado en puerta'),
      g.pendingVerification && chip('Verificación pendiente', 'warn'),
      g.prizeWonAt && chip(g.prizeDeliveredAt ? 'Premio entregado' : 'Premio ganado', 'prize')),
    g.dni && h('div', { className: 'muted' }, 'DNI ' + fmtDni(g.dni)),
    g.dietary && h('div', { className: 'diet' }, 'Restricción: ' + g.dietary),
    g.pin && pinBox(g.pin),
    act);
  card.onclick = (ev) => { if (!ev.target.closest('a, button')) showDetail(g.id); };
  return card;
}
// Door refresh: every 10 s while the Puerta tab is open and visible (search text and scroll are kept).
setInterval(() => { if (current === 'guests' && !document.hidden && !$('app').hidden) loadGuests(true); }, 10_000);

// Pending verifications. vSeen = how many pending requests the list already accounts for; the poll only
// raises a banner when the server has more, so a half-filled select or search is never rebuilt under the operator.
let vSeen = 0;
function checkVerifs() {
  const n = S.pendingVerifications - vSeen, b = $('verif-new');
  b.hidden = n <= 0;
  b.textContent = `${n} ${n === 1 ? 'verificación nueva' : 'verificaciones nuevas'} · Ver`;
}
const sfx = (g) => ` · DNI ${g.dni || '—'} · ${g.email || '—'}`; // DNI/email tell homonyms apart
function verifItem(v) {
  const opt = (g) => h('option', { value: g.id }, g.name + sfx(g) + (g.registered ? ' (ya confirmado)' : ''));
  const sel = h('select', { ariaLabel: 'Invitado para ' + v.name },
    h('option', { value: '' }, v.candidates.length ? 'Elige el invitado' : 'Sin coincidencias: busca abajo'),
    v.candidates.map((c) => opt(c)));
  const found = h('optgroup', { label: 'Búsqueda' });
  const q = h('input', { type: 'search', placeholder: 'Buscar otro invitado', autocomplete: 'off', ariaLabel: 'Buscar otro invitado' });
  let qt;
  q.oninput = () => {
    clearTimeout(qt);
    qt = setTimeout(async () => {
      const res = q.value.trim() ? (await run(() => api.adminGuests(q.value.trim())))?.guests : [];
      if (!res) return;
      found.replaceChildren(...res.slice(0, 20).map((g) => opt(g)));
      if (res.length) { sel.append(found); sel.options[0].textContent = 'Elige el invitado'; } else found.remove(); // never pre-selects: approving issues a PIN and cannot be undone
    }, 300);
  };
  const ok = h('button', { className: 'b primary', type: 'button' }, 'Aprobar');
  const no = h('button', { className: 'b', type: 'button' }, 'Rechazar');
  const item = h('div', { className: 'card' },
    h('strong', {}, v.name),
    h('div', { className: 'muted' }, `DNI ${v.dni || '—'} · ${v.email || '—'} · ${time(v.createdAt)}`),
    v.dietary && h('div', { className: 'muted' }, 'Restricción: ' + v.dietary),
    sel, q, h('div', { className: 'row' }, ok, no));
  item.dataset.vid = v.id;
  ok.onclick = async () => {
    if (!sel.value) return toast('Elige un invitado.', true);
    const name = sel.selectedOptions[0].textContent.split(' · ')[0];
    const r = await run(() => api.adminApproveVerification(v.id, Number(sel.value)));
    if (!r) return;
    item.replaceChildren(h('strong', {}, 'Aprobado: ' + name), pinBox(r.pin), ticketLink(r.ticketToken));
    item.dataset.done = '1'; vSeen--; // stays on screen (PIN and ticket link) until the tab is left
    toast(name + ' aprobado'); refresh(); loadGuests();
  };
  no.onclick = async () => {
    if (!confirm('¿Rechazar el registro de ' + v.name + '?')) return;
    if (await run(() => api.adminRejectVerification(v.id))) { item.remove(); vSeen--; $('verifs-empty').hidden = $('verifs').children.length > 0; refresh(); }
  };
  return item;
}
// Merges instead of rebuilding: rows already on screen keep their state (selection, search, approved ticket).
async function loadVerifs() {
  const rows = await run(api.adminVerifications);
  if (!rows) return;
  vSeen = rows.length; $('verif-new').hidden = true;
  const box = $('verifs'), ids = new Set(rows.map((v) => String(v.id)));
  for (const el of [...box.children]) if (!ids.has(el.dataset.vid) && !el.dataset.done) el.remove();
  const have = new Set([...box.children].map((el) => el.dataset.vid));
  for (const v of rows) if (!have.has(String(v.id))) box.append(verifItem(v));
  $('verifs-empty').hidden = box.children.length > 0;
  $('verif-card').hidden = !box.children.length; // the door screen stays short when there is nothing to verify
}
async function showDetail(id) {
  const g = await run(() => api.adminGuest(id));
  if (!g) return;
  const box = $('detail'); clear(box); box.hidden = false;
  box.append(h('h2', {}, g.name),
    h('p', { className: 'muted' }, g.checkedInAt ? 'Acreditado a las ' + time(g.checkedInAt) : 'Sin acreditar'),
    g.dietary && h('p', { className: 'diet' }, 'Restricción alimentaria: ' + g.dietary),
    g.pin && pinBox(g.pin),
    g.attempts.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ...['Juego', 'Puntaje', 'Tiempo'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...g.attempts.map((a) => h('tr', {}, h('td', {}, a.game),
          h('td', {}, a.score ?? 'en curso'), h('td', {}, a.durationMs != null ? (a.durationMs / 1000).toFixed(1) + ' s' : '—')))))
      : h('p', { className: 'muted' }, 'Sin intentos.'));
  box.scrollIntoView({ block: 'nearest' });
}

// ---- Juegos
function renderStock() {
  const { prizes } = S;
  $('counters').textContent = `Ganados: ${prizes.won} · Entregados: ${prizes.delivered} · Quedan: ${prizes.left}`;
  if (document.activeElement !== $('stock')) $('stock').value = prizes.stock;
}
function renderGames() {
  const box = $('game-cards'); clear(box);
  for (const g of S.games) {
    const defs = gameById(g.id)?.defaults ?? { params: {} };
    // Number input bounded by PARAM_INFO; unknown keys still get a plain input.
    const num = (k, v) => {
      const i = PARAM_INFO[k] ?? {};
      return h('input', { type: 'number', step: 1, min: i.min ?? '', max: i.max ?? '', value: v, id: `p-${g.id}-${k}` });
    };
    const f = {
      enabled: h('input', { type: 'checkbox', checked: g.enabled, id: `e-${g.id}` }),
      sort: num('sort', g.sort), threshold: num('threshold', g.threshold), maxAttempts: num('maxAttempts', g.maxAttempts),
    };
    const pf = Object.entries(g.params).map(([k, v]) => [k, num(k, v)]);
    const err = h('p', { className: 'err', role: 'alert', hidden: true });
    const save = h('button', { className: 'b primary', type: 'button' }, 'Guardar');
    save.onclick = async () => {
      const params = Object.fromEntries(pf.map(([k, i]) => [k, i.valueAsNumber]));
      err.hidden = true;
      const patch = { enabled: f.enabled.checked, sort: f.sort.valueAsNumber, threshold: f.threshold.valueAsNumber, maxAttempts: f.maxAttempts.valueAsNumber, params };
      if ([patch.sort, patch.threshold, patch.maxAttempts, ...Object.values(params)].some(Number.isNaN)) { err.textContent = 'Completa todos los números.'; err.hidden = false; return; }
      const bad = [...Object.values(f).slice(1), ...pf.map(([, i]) => i)].find((i) => !i.checkValidity());
      if (bad) { err.textContent = `«${bad.closest('.field').querySelector('label').textContent}»: ${bad.validationMessage}`; err.hidden = false; bad.focus(); return; }
      if (await saveGame(g.id, patch)) toast(`${g.name} guardado`);
    };
    // Label (with unit), the input, then one muted line: what it does and its default.
    const field = (k, ctl) => {
      const i = PARAM_INFO[k] ?? { label: k, help: '' };
      const d = k in defs ? defs[k] : defs.params[k];
      const unit = i.unit ? ` ${i.unit}` : '';
      return h('div', { className: 'field' }, h('label', { htmlFor: ctl.id }, i.label + (i.unit ? ` (${i.unit})` : '')), ctl,
        h('p', { className: 'hint' }, [i.help, d !== undefined && `Por defecto: ${d}${unit}.`].filter(Boolean).join(' ')));
    };
    box.append(h('div', { className: 'card gcard' },
      h('h2', {}, g.name, !g.ready && h('span', { className: 'badge' }, 'Próximamente')),
      h('label', { className: 'sw' }, f.enabled, h('span', {}, 'Habilitado')),
      h('h3', {}, 'Premio y acceso'),
      h('div', { className: 'grid2' }, field('threshold', f.threshold), field('maxAttempts', f.maxAttempts), field('sort', f.sort)),
      pf.length > 0 && h('h3', {}, 'Cómo se juega'),
      pf.length > 0 && h('div', { className: 'grid2' }, ...pf.map(([k, i]) => field(k, i))), err, save));
  }
}

// ---- Preparación: content CSVs (the guest CSV, speakers, prize list and video live in the same tab)
const CONTENT = {
  quiz: { title: 'Quiz: preguntas', hint: 'question,correct,wrong1,wrong2,wrong3,category', cols: [['question', 'Pregunta'], ['correct', 'Correcta'], ['category', 'Categoría']] },
  pixel: { title: 'Pixel Revelado: imágenes', hint: 'file,label,group (las imágenes se copian a data/content/pixel/ en el servidor)', cols: [['file', 'Archivo'], ['label', 'Etiqueta'], ['group', 'Grupo']] },
};
const IMPORT_ERRORS = {
  empty_field: 'campo vacío o faltante', question_too_long: 'pregunta de más de 110 caracteres', answer_too_long: 'respuesta de más de 40 caracteres',
  duplicate_answers: 'respuestas repetidas', invalid_file: 'nombre de archivo inválido', invalid_label: 'etiqueta vacía o de más de 40 caracteres',
  missing_file: 'el archivo no está en el servidor',
};
const lists = {};
async function loadContent(kind) {
  const rows = await run(() => api.adminContent(kind));
  if (!rows) return;
  const body = lists[kind]; clear(body);
  for (const r of rows) {
    const del = h('button', { className: 'b', type: 'button' }, 'Eliminar');
    del.onclick = async () => {
      if (confirm('¿Eliminar este elemento?') && await run(() => api.adminDeleteContent(kind, r.id)) !== undefined) loadContent(kind);
    };
    body.append(h('tr', {}, ...CONTENT[kind].cols.map(([k]) => h('td', {}, String(r[k] ?? ''))), h('td', {}, del)));
  }
}
function renderContent() {
  const box = $('content-cards');
  if (!box.children.length) {
    for (const [kind, c] of Object.entries(CONTENT)) {
      const file = h('input', { type: 'file', accept: '.csv,text/csv', id: 'ci-' + kind });
      const result = h('div', { 'aria-live': 'polite' });
      lists[kind] = h('tbody');
      file.onchange = async () => {
        const f = file.files[0];
        if (!f) return;
        if (f.size > 1_048_576) { file.value = ''; return toast('El archivo supera 1 MB.', true); }
        const r = await run(async () => api.adminImportContent(kind, await f.text()));
        file.value = '';
        if (!r) return;
        clear(result);
        result.append(h('p', {}, `Agregados: ${r.added} · Actualizados: ${r.updated} · Con errores: ${r.errors.length}`),
          r.errors.length > 0 && h('ul', { className: 'err' }, ...r.errors.map((e) => h('li', {}, `Línea ${e.line}: ${IMPORT_ERRORS[e.error] || e.error}`))));
        loadContent(kind);
      };
      box.append(h('div', { className: 'card' }, h('h2', {}, c.title),
        h('label', { htmlFor: 'ci-' + kind, className: 'muted' }, 'Importar CSV (', h('code', {}, c.hint), ')'), file, result,
        h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...c.cols.map(([, t]) => h('th', {}, t)), h('th'))), lists[kind]))));
    }
  }
  for (const kind of Object.keys(CONTENT)) loadContent(kind);
}

// ---- Resultados
async function renderResults() {
  const sel = $('rank-game');
  if (!sel.options.length) for (const g of S.games) sel.append(h('option', { value: g.id }, g.name));
  $('csv-link').href = api.attemptsCsvUrl;
  const [rows, winners] = await Promise.all([run(() => api.adminRanking(sel.value)), run(api.adminWinners)]);
  if (rows) {
    const body = $('ranking'); clear(body);
    rows.forEach((r, i) => body.append(h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.score), h('td', {}, (r.durationMs / 1000).toFixed(1) + ' s'))));
    $('ranking-empty').hidden = rows.length > 0;
  }
  if (winners) {
    $('winners').replaceChildren(...winners.map((w) => h('li', {}, w.name + (w.prize ? ' · ' + w.prize : '') + ' · ' + time(w.drawnAt))));
    $('winners-empty').hidden = winners.length > 0;
  }
}

// ---- Escenario: the LED wall behind the stage, driven like a vision mixer (plus the draw)
const SCENE_LABELS = { title: 'Título', ambient: 'Ambiente', speaker: 'Orador', raffle: 'Premios y sorteos', winner: 'Ganador', video: 'Video', black: 'Negro' };
const MIX = ['title', 'ambient', 'speaker', 'raffle', 'winner', 'video', 'black']; // keys 1-7 follow this order
let ST = null, stReady = false, spDraft = [], prizeTouched = false, stPending = 0;
async function loadStage(full) {
  if (!stReady) initStage();
  const [st, winners] = await Promise.all([run(api.adminStage), run(api.adminWinners)]);
  if (!st || !winners) return;
  ST = st;
  renderMixer(winners);
  renderRaffleMode();
  renderStrip();
  if (full) { spDraft = ST.speakers.map((x) => ({ ...x })); renderSpeakers(); $('st-prize-list').value = ST.prizes.join('\n'); $('st-video').value = ST.video; }
}
// Resolves true when the server accepted the change; the mixer is refreshed afterwards.
const setStage = async (patch) => {
  stPending++;
  try { const ok = !!(await run(() => api.adminSetStage(patch))); if (ok) await loadStage(); return ok; } finally { stPending--; }
};
const markOn = (scene) => {
  for (const b of $('st-mixer').children) { const on = b.dataset.scene === scene; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  const sp = ST.speakers[ST.speaker];
  $('st-now').textContent = 'En pantalla: ' + SCENE_LABELS[scene] + (scene === 'speaker' && sp ? ` (${sp.name})` : '');
};
function renderMixer(winners) {
  const sp = ST.speakers[ST.speaker], w = winners.find((x) => x.id === ST.winner);
  const subs = {
    title: 'Gala Digital Power 2026', ambient: 'Animaciones suaves que rotan', speaker: sp ? sp.name + (sp.role ? ' · ' + sp.role : '') : 'Sin oradores',
    raffle: 'Placa de premios', winner: w ? w.name + (w.prize ? ' · ' + w.prize : '') : 'Todavía no hay sorteos', video: ST.video || 'Sin video configurado', black: 'Pantalla apagada',
  };
  if (changed('mx', subs)) {
    $('st-mixer').replaceChildren(...MIX.map((scene, i) => {
      const b = h('button', { type: 'button', className: 'mx' }, h('kbd', {}, String(i + 1)), h('strong', {}, SCENE_LABELS[scene]), h('span', {}, subs[scene]));
      b.dataset.scene = scene;
      b.onclick = async () => {
        if (scene === 'winner' && !w) return toast('Todavía no hay ganadores: sortea primero.', true);
        markOn(scene); // optimistic: the tile lights up before the round trip
        if (!(await setStage({ scene }))) markOn(ST.scene);
      };
      return b;
    }));
  }
  markOn(ST.scene);
  $('st-sp').textContent = sp ? `${ST.speaker + 1} de ${ST.speakers.length}: ${sp.name}` : 'Sin oradores';
  $('st-prev').disabled = ST.speaker <= 0;
  $('st-next').disabled = ST.speaker >= ST.speakers.length - 1;
  if (changed('pz', ST.prizes)) $('st-prizes').replaceChildren(...ST.prizes.map((p) => h('option', { value: p })));
  if (!prizeTouched && document.activeElement !== $('st-prize')) $('st-prize').value = ST.prizes[winners.length] ?? ''; // next prize in the list
  if (changed('win', winners)) {
    $('st-winners').replaceChildren(...winners.map((x) => {
      const show = h('button', { type: 'button', className: 'b' }, 'Mostrar');
      show.onclick = () => setStage({ scene: 'winner', winner: x.id });
      const li = h('li', {}, x.name + (x.prize ? ' · ' + x.prize : '') + ' · ' + time(x.drawnAt), show);
      li.dataset.id = x.id;
      return li;
    }));
  }
  for (const li of $('st-winners').children) li.classList.toggle('on', Number(li.dataset.id) === ST.winner);
  $('st-winners-empty').hidden = winners.length > 0;
}
function renderSpeakers() {
  $('st-speakers').replaceChildren(...spDraft.map((x, i) => {
    const name = h('input', { value: x.name, maxLength: 60, placeholder: 'Nombre', ariaLabel: `Nombre del orador ${i + 1}` });
    const role = h('input', { value: x.role, maxLength: 60, placeholder: 'Cargo', ariaLabel: `Cargo del orador ${i + 1}` });
    name.oninput = () => { x.name = name.value; };
    role.oninput = () => { x.role = role.value; };
    const move = (label, d, aria) => {
      const b = h('button', { type: 'button', className: 'b', ariaLabel: aria, disabled: !spDraft[i + d] }, label);
      b.onclick = () => { [spDraft[i], spDraft[i + d]] = [spDraft[i + d], spDraft[i]]; renderSpeakers(); };
      return b;
    };
    const del = h('button', { type: 'button', className: 'b', ariaLabel: 'Quitar orador ' + (i + 1) }, '✕');
    del.onclick = () => { spDraft.splice(i, 1); renderSpeakers(); };
    return h('div', { className: 'st-sprow' }, name, role, move('↑', -1, 'Subir'), move('↓', 1, 'Bajar'), del);
  }));
}
// Sorteo: the winner line mirrors what the panels are showing; "Ocultar" takes it off the screens.
const showRaffle = (name) => { $('winner').textContent = name || ''; $('hide-raffle').hidden = !name; };
async function loadRaffle() {
  const l = await run(() => api.live());
  if (l) showRaffle(l.raffle?.name);
}
function renderRaffleMode() {
  const on = S.settings.raffleMode;
  $('raffle-mode').textContent = on ? 'Salir del modo sorteo' : 'Activar modo sorteo';
  $('raffle-mode').className = 'b' + (on ? '' : ' primary');
  $('raffle-mode-info').textContent = on
    ? 'Activo: las pantallas muestran «¡Los sorteos están por comenzar!» al terminar cada partida.'
    : 'Desactivado: las pantallas siguen con los juegos. Actívalo antes de sortear.';
}
function initStage() {
  stReady = true;
  $('st-link').href = new URL('stage.html', location.href).href;
  $('st-prev').onclick = () => setStage({ scene: 'speaker', speaker: ST.speaker - 1 });
  $('st-next').onclick = () => setStage({ scene: 'speaker', speaker: ST.speaker + 1 });
  $('st-cue').onclick = async () => {
    if (!confirm('¿Lanzar el momento WOW? Empieza en 6 segundos en los paneles y en el escenario.')) return;
    const b = $('st-cue'); b.disabled = true; // a second tap would restart the cue
    if (!(await run(api.adminCue))) { b.disabled = false; return; }
    toast('Momento WOW en 6 segundos'); loadStage();
    let n = 9;
    const t = setInterval(() => {
      if (n < 0) { clearInterval(t); b.textContent = 'Momento WOW'; b.disabled = false; return; }
      b.textContent = n > 4 ? `WOW en ${n - 4}…` : 'WOW en curso…'; n--;
    }, 1000);
    b.textContent = 'WOW en 6…';
  };
  $('st-prize').oninput = () => { prizeTouched = true; };
  $('st-draw').onclick = async () => {
    const prize = $('st-prize').value.trim();
    if (!confirm(`¿Sortear ${prize ? '«' + prize + '»' : 'un premio sin nombre'}? La pantalla LED y los 4 paneles empiezan el sorteo ahora.`)) return;
    const b = $('st-draw'); b.disabled = true;
    const w = await run(() => api.adminRaffle(prize));
    b.disabled = false;
    if (!w) return;
    toast('Ganador: ' + w.name); showRaffle(w.name);
    prizeTouched = false;
    refresh(); loadStage();
  };
  $('hide-raffle').onclick = async () => { if (await run(api.adminHideRaffle)) { toast('Ocultado en las pantallas'); showRaffle(''); } };
  $('raffle-mode').onclick = async () => { if (await setting({ raffleMode: !S.settings.raffleMode })) renderRaffleMode(); };
  $('st-add').onclick = () => { spDraft.push({ name: '', role: '' }); renderSpeakers(); $('st-speakers').lastChild.querySelector('input').focus(); };
  $('st-save-sp').onclick = async () => {
    const speakers = spDraft.map((x) => ({ name: x.name.trim(), role: x.role.trim() })).filter((x) => x.name);
    if (await run(() => api.adminSetStage({ speakers }))) { toast('Oradores guardados'); loadStage(true); }
  };
  $('st-save').onclick = async () => {
    const prizes = $('st-prize-list').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (prizes.some((x) => x.length > 80)) return toast('Cada premio puede tener hasta 80 caracteres.', true);
    if (await run(() => api.adminSetStage({ prizes, video: $('st-video').value.trim() }))) { toast('Premios y video guardados'); prizeTouched = false; loadStage(true); }
  };
}
// Mixer refresh: every 3 s while the Escenario tab is open (another operator may switch plates too); never mid-change.
setInterval(() => { if (current === 'stage' && !document.hidden && !$('app').hidden && !stPending) loadStage(); }, 3000);
// Keyboard on Escenario only: 1-7 scenes (mixer order), arrows speaker prev/next. Deliberately none for WOW or the draw.
addEventListener('keydown', (ev) => {
  if (current !== 'stage' || $('app').hidden || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const btn = /^[1-7]$/.test(ev.key) ? $('st-mixer').children[ev.key - 1] : ev.key === 'ArrowLeft' ? $('st-prev') : ev.key === 'ArrowRight' ? $('st-next') : null;
  if (btn && !btn.disabled) { ev.preventDefault(); btn.click(); }
});

// ---- Wiring
async function boot() {
  let dark = true;
  try { dark = localStorage.getItem('fiesta.admin.dark') !== '0'; } catch {}
  setTheme(dark);
  if (api.isDemo) { $('demo').hidden = false; return; }
  for (const [k, label] of TABS) {
    const b = h('button', { type: 'button', role: 'tab', id: 'tab-' + k }, label,
      k === 'guests' && h('span', { className: 'badge prize', id: 'verif-count', hidden: true, title: 'Verificaciones pendientes' }));
    b.dataset.tab = k; b.onclick = () => select(k);
    $('tabs').append(b);
  }
  $('login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    if (await run(() => api.adminLogin($('pw').value))) enter();
  };
  $('logout').onclick = async () => { if (confirm('¿Salir del panel?')) { await run(api.adminLogout); showLogin(); } };
  $('theme').onclick = () => setTheme(!document.body.classList.contains('dark'));
  $('paused').onchange = async (ev) => {
    if (ev.target.checked && !confirm('¿Pausar los 4 paneles de juego? Nadie podrá jugar hasta que lo reactives.')) { ev.target.checked = false; return; }
    if (!(await setting({ paused: ev.target.checked }))) renderLive(); // failed: back to the server value
  };
  $('trans').onchange = async (ev) => { if (!(await setting({ transition: ev.target.checked }))) renderLive(); };
  $('trans-save').onclick = () => setting({ transitionText: $('trans-text').value }).then((r) => r && toast('Texto guardado'));
  $('verif-new').onclick = loadVerifs;
  $('ag-from-q').onclick = () => { $('ag-name').value = $('gq').value.trim(); $('add-box').open = true; $('ag-name').focus(); };
  $('add-guest').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $('ag-name').value.trim();
    const r = await run(() => api.adminAddGuest({ name, dni: $('ag-dni').value.trim(), email: $('ag-email').value.trim() }));
    if (!r) return;
    ev.target.reset(); $('add-box').open = false; $('gq').value = name; gFilter = 'all'; lastAct = `${name} agregado ${time(Date.now())}`;
    await loadGuests(); $('gq').scrollIntoView({ block: 'start' });
  };
  $('gq').oninput = () => { clearTimeout(gTimer); gTimer = setTimeout(loadGuests, 300); };
  $('csv').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    if (f.size > 1_048_576) { ev.target.value = ''; return toast('El archivo supera 1 MB.', true); }
    const r = await run(async () => api.adminImportGuests(await f.text()));
    ev.target.value = '';
    if (r) { toast(`Agregados: ${r.added}`); loadGuests(); }
  };
  $('stock-save').onclick = async () => {
    const n = $('stock').valueAsNumber;
    if (!Number.isInteger(n) || n < 0) return toast('Ingresa un stock válido.', true);
    if (await setting({ prizeStock: n })) { await refresh(); renderStock(); toast('Stock guardado'); }
  };
  $('rank-game').onchange = renderResults;

  try { await api.adminMe(); enter(); } catch (e) { if (e.code === 'unauthorized') showLogin(); else { showLogin(); toast(ERRORS[e.code] || 'Ocurrió un error inesperado.', true); } }
}
boot();
