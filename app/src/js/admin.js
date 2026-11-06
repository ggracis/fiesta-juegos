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
async function run(fn) {
  try { return await fn(); } catch (e) {
    if (e.code === 'unauthorized') showLogin();
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
let timer;
const TABS = [['live', 'En vivo'], ['guests', 'Invitados'], ['games', 'Juegos'], ['content', 'Contenido'], ['prizes', 'Premios y ranking'], ['raffle', 'Sorteo']];

function showLogin() {
  clearInterval(timer);
  $('app').hidden = true; $('login').hidden = false; $('pw').value = ''; $('pw').focus();
}
function enter() {
  const next = safeNext();
  if (next) { location.replace(next); return; }
  $('login').hidden = true; $('app').hidden = false;
  let tab = 'live';
  try { tab = localStorage.getItem('fiesta.admin.tab') || tab; } catch {}
  select(TABS.some(([k]) => k === tab) ? tab : 'live');
}

async function refresh() {
  const s = await run(api.adminState);
  if (s) {
    S = s;
    const n = $('verif-count');
    n.textContent = s.pendingVerifications; n.hidden = !s.pendingVerifications;
  }
  return s;
}

let current;
async function select(tab) {
  current = tab;
  try { localStorage.setItem('fiesta.admin.tab', tab); } catch {}
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const [k] of TABS) $('t-' + k).hidden = k !== tab;
  clearInterval(timer);
  if (!(await refresh()) || current !== tab) return;
  ({ live: renderLive, guests: () => { loadVerifs(); loadGuests(); }, games: renderGames, content: renderContent, prizes: renderPrizes, raffle: loadRaffle })[tab]();
  if (tab === 'live') timer = setInterval(async () => { if (!document.hidden && current === 'live' && await refresh()) renderLive(); }, 5000);
}

// ---- En vivo
const setting = (patch) => run(() => api.adminSettings(patch)).then((r) => { if (r) { Object.assign(S.settings, r); renderLive(); } return r; });
const saveGame = (id, patch) => run(() => api.adminGame(id, patch)).then(async (g) => { if (g) await refresh(); return g; });

function renderLive() {
  const { settings, games, screens } = S;
  $('paused').checked = settings.paused;
  $('trans').checked = settings.transition;
  if (document.activeElement !== $('trans-text')) $('trans-text').value = settings.transitionText;
  const box = $('live-games'); clear(box);
  for (const g of games) {
    const cb = h('input', { type: 'checkbox', checked: g.enabled, disabled: !g.ready });
    cb.onchange = () => saveGame(g.id, { enabled: cb.checked }).then(renderLive);
    box.append(h('label', { className: 'sw' }, cb, h('span', {}, g.name + (g.ready ? '' : ' (próximamente)'))));
  }
  const body = $('screens'); clear(body);
  const now = Date.now();
  for (const s of screens) {
    body.append(h('tr', {}, h('td', {}, s.id.slice(0, 8)), h('td', {}, s.game),
      h('td', {}, `hace ${Math.max(0, Math.round((now - s.lastSeen) / 1000))} s`),
      h('td', {}, h('span', { className: 'dot' + (s.online ? ' on' : '') }), s.online ? 'En línea' : 'Sin señal')));
  }
  $('screens-empty').hidden = screens.length > 0;
}

// ---- Invitados
const time = (ms) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
let gTimer;
async function loadGuests() {
  const rows = await run(() => api.adminGuests($('gq').value.trim()));
  if (!rows) return;
  const body = $('guests'); clear(body);
  for (const g of rows) {
    const btn = g.registered
      ? h('button', { className: 'b', type: 'button', disabled: !!g.checkedInAt }, g.checkedInAt ? 'Acreditado' : 'Acreditar')
      : h('button', { className: 'b primary', type: 'button' }, 'Acreditar y dar entrada');
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (g.registered) { if (await run(() => api.adminCheckinGuest(g.id))) { toast(`${g.name} acreditado`); loadGuests(); } return; }
      if (!confirm(`¿Acreditar a ${g.name}? No había confirmado asistencia.`)) return;
      const r = await run(() => api.adminWalkIn(g.id));
      if (r) { await loadGuests(); showTicket(g.name, r.ticketToken); }
    };
    const tr = h('tr', { className: 'click' },
      h('td', {}, g.name, g.dietary && h('div', { className: 'muted' }, 'Restricción: ' + g.dietary)),
      h('td', {},
        h('span', { className: 'badge' + (g.registered ? ' ok' : '') }, g.registered ? 'Confirmado' : 'Sin confirmar'),
        g.checkedInAt && h('span', { className: 'badge ok' }, 'Acreditado ' + time(g.checkedInAt)),
        g.walkIn && h('span', { className: 'badge' }, 'Agregado en puerta'),
        g.prizeWonAt && h('span', { className: 'badge prize' }, g.prizeDeliveredAt ? 'Premio entregado' : 'Premio ganado')),
      h('td', {}, btn));
    tr.onclick = () => showDetail(g.id);
    body.append(tr);
  }
  $('guests-empty').hidden = rows.length > 0;
}
const ticketLink = (token) =>
  h('a', { className: 'b primary', href: 'ticket.html?t=' + encodeURIComponent(token), target: '_blank', rel: 'noopener' }, 'Abrir ticket (QR y PIN)');
// Walk-in result: shown in the detail card so the guest can see their PIN on the staff phone.
function showTicket(name, token) {
  const box = $('detail'); clear(box); box.hidden = false;
  box.append(h('h2', {}, name + ' acreditado'), h('p', { className: 'muted' }, 'Muéstrale el ticket o que le saque una foto al PIN.'), ticketLink(token));
  box.scrollIntoView({ block: 'nearest' });
}
// Not reloaded on search keystrokes, so the ticket link of a just-approved request stays on screen.
async function loadVerifs() {
  const rows = await run(api.adminVerifications);
  if (!rows) return;
  const box = $('verifs'); clear(box);
  for (const v of rows) {
    const opt = (g, extra = '') => h('option', { value: g.id }, g.name + extra + (g.registered ? ' (ya confirmado)' : ''));
    const sel = h('select', { ariaLabel: 'Invitado para ' + v.name },
      h('option', { value: '' }, v.candidates.length ? 'Elige el invitado' : 'Sin coincidencias: busca abajo'),
      v.candidates.map((c) => opt(c, ` · DNI ${c.dni || '—'} · ${c.email || '—'}`)));
    const found = h('optgroup', { label: 'Búsqueda' });
    const q = h('input', { type: 'search', placeholder: 'Buscar otro invitado', autocomplete: 'off', ariaLabel: 'Buscar otro invitado' });
    let qt;
    q.oninput = () => {
      clearTimeout(qt);
      qt = setTimeout(async () => {
        const res = q.value.trim() ? await run(() => api.adminGuests(q.value.trim())) : [];
        if (!res) return;
        found.replaceChildren(...res.slice(0, 20).map((g) => opt(g)));
        if (res.length) { sel.append(found); sel.value = String(res[0].id); } else found.remove();
      }, 300);
    };
    const ok = h('button', { className: 'b primary', type: 'button' }, 'Aprobar');
    const no = h('button', { className: 'b', type: 'button' }, 'Rechazar');
    const item = h('div', { className: 'card' },
      h('strong', {}, v.name),
      h('div', { className: 'muted' }, `DNI ${v.dni || '—'} · ${v.email || '—'} · ${time(v.createdAt)}`),
      v.dietary && h('div', { className: 'muted' }, 'Restricción: ' + v.dietary),
      sel, q, h('div', { className: 'row' }, ok, no));
    ok.onclick = async () => {
      if (!sel.value) return toast('Elige un invitado.', true);
      const name = sel.selectedOptions[0].textContent.split(' · ')[0];
      const r = await run(() => api.adminApproveVerification(v.id, Number(sel.value)));
      if (!r) return;
      item.replaceChildren(h('strong', {}, 'Aprobado: ' + name), ticketLink(r.ticketToken));
      toast(name + ' aprobado'); refresh(); loadGuests();
    };
    no.onclick = async () => {
      if (!confirm('¿Rechazar el registro de ' + v.name + '?')) return;
      if (await run(() => api.adminRejectVerification(v.id))) { item.remove(); $('verifs-empty').hidden = box.children.length > 0; refresh(); }
    };
    box.append(item);
  }
  $('verifs-empty').hidden = rows.length > 0;
}
async function showDetail(id) {
  const g = await run(() => api.adminGuest(id));
  if (!g) return;
  const box = $('detail'); clear(box); box.hidden = false;
  box.append(h('h2', {}, g.name),
    h('p', { className: 'muted' }, g.checkedInAt ? 'Acreditado a las ' + time(g.checkedInAt) : 'Sin acreditar'),
    g.dietary && h('p', {}, 'Restricción alimentaria: ' + g.dietary),
    g.attempts.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ...['Juego', 'Puntaje', 'Tiempo'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...g.attempts.map((a) => h('tr', {}, h('td', {}, a.game),
          h('td', {}, a.score ?? 'en curso'), h('td', {}, a.durationMs != null ? (a.durationMs / 1000).toFixed(1) + ' s' : '—')))))
      : h('p', { className: 'muted' }, 'Sin intentos.'));
  box.scrollIntoView({ block: 'nearest' });
}

// ---- Juegos
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

// ---- Contenido
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

// ---- Premios y ranking
async function renderPrizes() {
  const { prizes, games } = S;
  $('counters').textContent = `Ganados: ${prizes.won} · Entregados: ${prizes.delivered} · Quedan: ${prizes.left}`;
  if (document.activeElement !== $('stock')) $('stock').value = prizes.stock;
  const sel = $('rank-game');
  if (!sel.options.length) for (const g of games) sel.append(h('option', { value: g.id }, g.name));
  $('csv-link').href = api.attemptsCsvUrl;
  const rows = await run(() => api.adminRanking(sel.value));
  if (!rows) return;
  const body = $('ranking'); clear(body);
  rows.forEach((r, i) => body.append(h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.score), h('td', {}, (r.durationMs / 1000).toFixed(1) + ' s'))));
  $('ranking-empty').hidden = rows.length > 0;
}

// ---- Sorteo
function renderRaffleMode() {
  const on = S.settings.raffleMode;
  $('raffle-mode').textContent = on ? 'Salir del modo sorteo' : 'Activar modo sorteo';
  $('raffle-mode').className = 'b' + (on ? '' : ' primary');
  $('raffle-mode-info').textContent = on
    ? 'Activo: las pantallas muestran «¡Los sorteos están por comenzar!» al terminar cada partida.'
    : 'Desactivado: las pantallas siguen con los juegos. Actívalo antes de sortear.';
}
async function loadRaffle() {
  renderRaffleMode();
  const [l, winners] = await Promise.all([run(() => api.live()), run(api.adminWinners)]);
  if (l?.raffle) { $('winner').textContent = l.raffle.name; $('hide-raffle').hidden = false; }
  if (!winners) return;
  $('winners').replaceChildren(...winners.map((w) => h('li', {}, w.name + ' · ' + time(w.drawnAt))));
  $('winners-empty').hidden = winners.length > 0;
  $('draw').textContent = winners.length ? 'Sortear otro premio' : 'Sortear';
}
async function draw() {
  const msg = S.settings.raffleMode ? '¿Sortear un ganador entre los acreditados?' : 'El modo sorteo está desactivado: las pantallas mostrarán el ganador al terminar cada partida. ¿Sortear igual?';
  if (!confirm(msg)) return;
  const w = await run(api.adminRaffle);
  if (!w) return;
  toast('Ganador: ' + w.name);
  loadRaffle();
}

// ---- Wiring
async function boot() {
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
  $('logout').onclick = async () => { await run(api.adminLogout); showLogin(); };
  $('paused').onchange = (ev) => setting({ paused: ev.target.checked });
  $('trans').onchange = (ev) => setting({ transition: ev.target.checked });
  $('trans-save').onclick = () => setting({ transitionText: $('trans-text').value }).then((r) => r && toast('Texto guardado'));
  $('add-guest').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $('ag-name').value.trim();
    const r = await run(() => api.adminAddGuest({ name, dni: $('ag-dni').value.trim(), email: $('ag-email').value.trim() }));
    if (!r) return;
    ev.target.reset(); $('gq').value = name;
    await loadGuests(); showTicket(name, r.ticketToken);
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
    if (await setting({ prizeStock: n })) { await refresh(); renderPrizes(); toast('Stock guardado'); }
  };
  $('rank-game').onchange = renderPrizes;
  $('draw').onclick = draw;
  $('raffle-mode').onclick = async () => { if (await setting({ raffleMode: !S.settings.raffleMode })) renderRaffleMode(); };
  $('hide-raffle').onclick = async () => { if (await run(api.adminHideRaffle)) { toast('Ocultado en las pantallas'); $('hide-raffle').hidden = true; } };

  try { await api.adminMe(); enter(); } catch (e) { if (e.code === 'unauthorized') showLogin(); else { showLogin(); toast(ERRORS[e.code] || 'Ocurrió un error inesperado.', true); } }
}
boot();
