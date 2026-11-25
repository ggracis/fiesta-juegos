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
  unknown_game: 'Juego desconocido.', not_found: 'No encontrado.', csv_required: 'Selecciona un archivo .xlsx o .csv.',
  file_invalid: 'No pudimos leer el archivo. Sube un Excel (.xlsx) o un CSV válido; puedes bajar el ejemplo.', file_empty: 'No encontramos invitados en el archivo. Revisa que el nombre esté en la columna A.',
  too_soon: 'Ya se envió hace instantes. Espera un minuto.', no_email: 'Ese invitado no tiene email.', send_failed: 'No se pudo enviar el correo.',
  guest_exists: 'Ya existe un invitado con ese nombre: búscalo en la lista.',
  not_duplicate: 'Ya no hay otro invitado con ese nombre: no se elimina.', guest_in_use: 'Ese invitado ya jugó o participó del sorteo: no se puede eliminar.',
  already_voided: 'Ese sorteo ya estaba anulado.', already_resolved: 'Esa verificación ya fue resuelta.', http: 'Error del servidor.', already_checked_in: 'Ya estaba acreditado.',
  pending_validation: 'La inscripción de esta persona está pendiente de validación. Apruébala en Verificaciones pendientes.',
  already_pending: 'Esa inscripción ya está pendiente de validación.',
  checkin_not_open: 'La acreditación se habilita el lunes 30/11, el día del evento. Esta persona ya está confirmada y tiene su entrada.',
  image_required: 'Elige una imagen JPG, PNG o WebP.', invalid_image: 'El archivo no es una imagen JPG, PNG o WebP válida.', demo_unavailable: 'No disponible en el modo demo.',
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
    else if (e.status === 413) toast('El archivo es demasiado grande (máx. 5 MB).', true);
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
const ALL_TABS = [['guests', 'Puerta'], ['stage', 'Escenario'], ['live', 'Paneles'], ['games', 'Juegos'], ['results', 'Resultados'], ['setup', 'Preparación']];
let TABS = ALL_TABS, door = false; // door (reception) role: Puerta only

// Dark by default (venue lighting); the choice is remembered per device.
function setTheme(dark) {
  document.body.classList.toggle('dark', dark);
  $('theme').textContent = dark ? 'Modo claro' : 'Modo oscuro';
  try { localStorage.setItem('fiesta.admin.dark', dark ? '1' : '0'); } catch {}
}

function showLogin() {
  $('app').hidden = true; $('login').hidden = false; $('pw').value = ''; $('pw').focus();
}
function enter(role) {
  const next = safeNext();
  if (next) { location.replace(next); return; }
  door = role === 'door';
  TABS = door ? ALL_TABS.slice(0, 1) : ALL_TABS; // the other panes stay hidden and their loaders never run
  $('tabs').replaceChildren(...TABS.map(([k, label]) => {
    const b = h('button', { type: 'button', role: 'tab', id: 'tab-' + k }, label,
      k === 'guests' && h('span', { className: 'badge prize', id: 'verif-count', hidden: true, title: 'Verificaciones pendientes' }));
    b.dataset.tab = k; b.onclick = () => select(k);
    return b;
  }));
  $('tabs').hidden = $('strip').hidden = door;
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
  if (!S?.settings) return;
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
    const [s, st] = await Promise.all([refresh(), current === 'stage' || door ? null : run(api.adminStage)]); // Escenario polls itself every 3 s
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
  for (const [k] of ALL_TABS) $('t-' + k).hidden = k !== tab;
  if (!(await refresh()) || current !== tab) return;
  if (!ST && tab !== 'stage' && !door) run(api.adminStage).then((st) => { if (st) { ST = st; renderStrip(); } }); // LED scene for the strip
  ({
    guests: () => { loadVerifs(); loadGuests(); loadRejected(); }, live: renderLive, games: () => { renderStock(); renderGames(); }, results: renderResults,
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
// After a door action started from a search, the box is cleared and refocused for the next guest in line.
const nextGuest = () => { if ($('gq').value.trim()) { $('gq').value = ''; $('gq').focus(); } loadGuests(); };
const ticketUrl = (token) => new URL('ticket.html?staff&t=' + encodeURIComponent(token), location.href).href; // ?staff: not remembered on this device
const ticketLink = (token) => h('a', { className: 'b primary', href: ticketUrl(token), target: '_blank', rel: 'noopener' }, 'Abrir ticket (QR y PIN)');

// PIN in plain sight: staff read it to the guest at the door.
const pinBox = (pin) => h('div', { className: 'pinrow' }, h('span', { className: 'muted' }, 'PIN'), h('code', { className: 'pin' }, pin));

// Door mode: search, filter chips, one big card per guest with the action that fits its state.
const FILTER_LABELS = [['all', 'Todos'], ['unaccredited', 'Sin acreditar'], ['accredited', 'Acreditados'], ['unconfirmed', 'No confirmados'], ['walkIn', 'Agregados en puerta'], ['duplicates', 'Posibles duplicados']];
let gFilter = 'unaccredited', gSeq = 0, lastAct = '', down = false, gOpen = true; // gOpen: check-in allowed today (server clock)
// Background refreshes never replace cards while a finger or mouse button is down.
addEventListener('pointerdown', () => { down = true; }, true);
for (const t of ['pointerup', 'pointercancel']) addEventListener(t, () => { down = false; }, true);
async function loadGuests(bg) {
  const seq = bg ? gSeq : ++gSeq; // a user-triggered load (search, filter) supersedes any load still in flight
  const q = $('gq').value.trim();
  const res = await run(() => api.adminGuests(q, gFilter));
  if (!res || seq !== gSeq || (bg && down)) return;
  if (!changed('g', res) && bg) return;
  const { guests, counts, summary } = res;
  gOpen = res.checkinOpen !== false; $('door-closed').hidden = gOpen;
  const y = scrollY; // refreshes must not move the list under the staff's finger
  $('gfilters').replaceChildren(...FILTER_LABELS.map(([k, label]) => {
    const b = h('button', { type: 'button', className: 'chip', ariaPressed: String(k === gFilter) }, `${label} · ${counts[k]}`);
    b.onclick = () => { gFilter = k; loadGuests(); };
    return b;
  }));
  $('gsum').replaceChildren(`${summary.total} invitados · ${summary.confirmed} confirmados · ${summary.accredited} acreditados`,
    lastAct && h('span', { className: 'last' }, 'Última acción: ' + lastAct));
  $('guests').replaceChildren(...[...guests].sort((a, b) => a.rejected - b.rejected).map(guestCard)); // rejected guests go last
  $('guests-empty').hidden = guests.length > 0;
  $('guests-empty-t').textContent = 'Sin resultados.' + (gFilter === 'all' ? '' : ' Prueba con el filtro «Todos».');
  $('ag-from-q').hidden = !q; $('ag-from-q').textContent = `Agregar «${q}»`;
  scrollTo(0, y);
}
function guestCard(g) {
  const chip = (text, cls = '') => h('span', { className: 'badge ' + cls }, text);
  let act;
  if (g.onHold || g.rejected) act = null; // back under validation: nothing to do here until it is approved
  else if (g.checkedInAt) act = h('a', { className: 'b', href: ticketUrl(g.ticketToken), target: '_blank', rel: 'noopener' }, 'Ver entrada');
  else if (g.registered && !gOpen) act = null; // before event day: nothing to press (the banner explains why)
  else if (g.registered) {
    act = h('button', { className: 'b primary', type: 'button' }, 'Acreditar'); // no confirm: speed at the door matters
    act.onclick = async (ev) => {
      ev.stopPropagation();
      if (await run(() => api.adminCheckinGuest(g.id))) { lastAct = `${g.name} acreditado ${time(Date.now())}`; toast(`${g.name} acreditado`); nextGuest(); }
    };
  } else {
    act = h('button', { className: 'b primary', type: 'button' }, gOpen ? 'Acreditar' : 'Dar entrada');
    act.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(gOpen ? `¿Acreditar a ${g.name}? No había confirmado asistencia.` : `¿Dar entrada a ${g.name}? No había confirmado asistencia.`)) return;
      const r = await run(() => api.adminWalkIn(g.id));
      if (r) { const what = r.checkedIn ? 'acreditado' : 'confirmado (se acredita el 30/11)'; lastAct = `${g.name} ${what} ${time(Date.now())}`; toast(`${g.name} ${what} · PIN ${r.pin}`); nextGuest(); }
    };
  }
  // Compact row: who (name, email, PIN, flags) on the left, the one action on the right, so a phone shows several guests at once.
  const card = h('article', { className: 'card guest' + (g.checkedInAt ? ' done' : '') },
    h('div', { className: 'gwho' },
      h('strong', {}, g.name),
      h('div', { className: 'gmeta' }, g.pin && h('span', { className: 'gpin' }, 'PIN ', h('b', {}, g.pin)), g.email && h('span', {}, g.email)),
      h('div', { className: 'gtop' },
        g.checkedInAt ? chip('Acreditado ✓ ' + time(g.checkedInAt), 'ok') : !g.registered && chip('No confirmado'),
        g.walkIn && chip('Agregado en puerta'),
        g.pendingVerification && chip('Verificación pendiente', 'warn'),
        g.duplicate && chip('Posible duplicado', 'warn'),
        g.onHold && chip('Pendiente de validación', 'warn'),
      g.rejected && chip('Rechazado', 'bad'),
      g.raffleOut && chip('No participa de sorteos', 'warn'),
      g.prizeWonAt && chip(g.prizeDeliveredAt ? 'Premio entregado' : 'Premio ganado', 'prize')),
      g.dietary && h('div', { className: 'diet' }, 'Restricción: ' + g.dietary)),
    act,
    h('div', { className: 'gsub' }, g.registered && !g.onHold && revalidateButton(g), !door && raffleButton(g)), // reception validates inscriptions too; raffles stay admin-only
    g.duplicate && deleteDupButton(g));
  card.onclick = (ev) => { if (!ev.target.closest('a, button')) showDetail(g.id); };
  return card;
}
// "Revalidar inscripción": back to the validation queue (QR and PIN blocked until approved; approving sends no new mail).
function revalidateButton(g) {
  const b = h('button', { className: 'b sub', type: 'button' }, 'Revalidar inscripción');
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm(`¿Revalidar la inscripción de ${g.name}? Su QR y su PIN dejan de funcionar hasta que se apruebe en Verificaciones pendientes. No se le envía ningún mail.`)) return;
    if (await run(() => api.adminRevalidate(g.id))) { toast(`${g.name}: pendiente de validación`); loadGuests(); refresh(); }
  };
  return b;
}
// Raffle participation toggle (admin only): everyone takes part unless staff takes them out.
function raffleButton(g) {
  const b = h('button', { className: 'b sub', type: 'button' }, g.raffleOut ? 'Incluir en sorteos' : 'Excluir de sorteos');
  b.onclick = async (ev) => {
    ev.stopPropagation();
    const r = await run(() => api.adminSetRaffle(g.id, !!g.raffleOut));
    if (r) { toast(`${g.name}: ${r.participates ? 'participa' : 'no participa'} de los sorteos`); loadGuests(); }
  };
  return b;
}
function deleteDupButton(g) {
  const b = h('button', { className: 'b danger', type: 'button' }, 'Eliminar duplicado');
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm(`¿Eliminar a ${g.name}${g.email ? ` (${g.email})` : ''}? Su QR y su PIN siguen funcionando: quedan unificados con el otro registro.`)) return;
    const r = await run(() => api.adminDeleteGuest(g.id));
    if (r) { lastAct = `${g.name} unificado con ${r.mergedInto} ${time(Date.now())}`; toast(`${g.name} eliminado · unificado con ${r.mergedInto}`); loadGuests(); }
  };
  return b;
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
// One inscription to approve. New: approving creates the guest and mails the ticket. Revalidation: approving gives back the same
// ticket without mail. A new name that matches someone already on the list offers that guest too (namesakes).
function verifItem(v) {
  const reval = v.kind === 'revalidate';
  const known = !reval && v.candidates.length > 0;
  const sel = known && h('select', { ariaLabel: 'Invitado para ' + v.name },
    h('option', { value: '' }, 'Es una persona nueva'),
    v.candidates.map((g) => h('option', { value: g.id }, `Es ${g.name} · ${g.email || '—'}` + (g.registered ? ' (ya confirmado)' : ''))));
  const ok = h('button', { className: 'b primary', type: 'button' }, 'Aprobar');
  const no = h('button', { className: 'b', type: 'button' }, 'Rechazar');
  const item = h('div', { className: 'card' },
    h('div', { className: 'gtop' }, h('strong', {}, v.name), h('span', { className: 'badge ' + (reval ? 'warn' : 'ok') }, reval ? 'Revalidación' : 'Inscripción nueva')),
    h('div', { className: 'muted' }, `${v.email || '—'} · ${time(v.createdAt)}`),
    v.dietary && h('div', { className: 'muted' }, 'Restricción: ' + v.dietary),
    sel, h('div', { className: 'row' }, ok, no));
  item.dataset.vid = v.id;
  ok.onclick = async () => {
    const guestId = reval ? v.candidates[0]?.id : sel && sel.value ? Number(sel.value) : null; // null: a new guest from the request
    const r = await run(() => api.adminApproveVerification(v.id, guestId));
    if (!r) return;
    item.replaceChildren(h('strong', {}, 'Aprobado: ' + v.name), pinBox(r.pin), ticketLink(r.ticketToken));
    item.dataset.done = '1'; vSeen--; // stays on screen (PIN and ticket link) until the tab is left
    toast(v.name + (reval ? ' aprobado' : ' aprobado · se le envió el mail')); refresh(); loadGuests();
  };
  no.onclick = async () => {
    if (!confirm(`¿Rechazar a ${v.name}? ${reval ? 'Su QR y su PIN siguen bloqueados.' : 'No recibe ninguna entrada.'} Queda en «Rechazados», al final de la página.`)) return;
    if (await run(() => api.adminRejectVerification(v.id))) { item.remove(); vSeen--; $('verifs-empty').hidden = $('verifs').children.length > 0; refresh(); loadGuests(); loadRejected(); }
  };
  return item;
}
// Rejected inscriptions at the bottom of Puerta: still approvable if the rejection was a mistake.
async function loadRejected() {
  const rows = await run(() => api.adminVerifications('rejected'));
  if (!rows) return;
  $('rejected').replaceChildren(...rows.map((v) => {
    const reval = v.kind === 'revalidate';
    const ok = h('button', { className: 'b', type: 'button' }, 'Aprobar');
    ok.onclick = async () => {
      if (!confirm(`¿Aprobar a ${v.name}?${reval ? ' Recupera su mismo QR y PIN.' : ' Se le envía el mail con su PIN y su QR.'}`)) return;
      if (await run(() => api.adminApproveVerification(v.id, reval ? v.candidates[0]?.id : null))) { toast(v.name + ' aprobado'); loadRejected(); loadGuests(); }
    };
    return h('div', { className: 'card rej' }, h('div', { className: 'gtop' }, h('strong', {}, v.name), h('span', { className: 'badge' }, reval ? 'Revalidación rechazada' : 'Inscripción rechazada')),
      h('div', { className: 'muted' }, v.email || '—'), ok);
  }));
  $('rejected-card').hidden = !rows.length;
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
function resendButton(g) {
  const b = h('button', { className: 'b', type: 'button' }, 'Reenviar entrada por mail');
  b.onclick = async () => { b.disabled = true; if (await run(() => api.adminResendEmail(g.id))) toast('Entrada reenviada a ' + g.email); b.disabled = false; };
  return b;
}
async function showDetail(id) {
  const g = await run(() => api.adminGuest(id));
  if (!g) return;
  const box = $('detail'); clear(box);
  const close = h('button', { className: 'b sheet-x', type: 'button', ariaLabel: 'Cerrar' }, 'Cerrar');
  close.onclick = () => box.close();
  box.append(...[h('div', { className: 'sheet-head' }, h('h2', {}, g.name), close),
    h('p', { className: 'muted' }, g.checkedInAt ? 'Acreditado a las ' + time(g.checkedInAt) : 'Sin acreditar'),
    g.dietary && h('p', { className: 'diet' }, 'Restricción alimentaria: ' + g.dietary),
    g.pin && pinBox(g.pin),
    !!g.registered && !!g.email && resendButton(g),
    g.attempts.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ...['Juego', 'Puntaje', 'Tiempo'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...g.attempts.map((a) => h('tr', {}, h('td', {}, a.game),
          h('td', {}, a.score ?? 'en curso'), h('td', {}, a.durationMs != null ? (a.durationMs / 1000).toFixed(1) + ' s' : '—')))))
      : h('p', { className: 'muted' }, 'Sin intentos.')].filter((k) => k != null && k !== false)); // native append would print null/false
  if (!box.open) box.showModal();
}
// Tap outside the sheet closes it (inside clicks land on its children or its own box).
$('detail').addEventListener('click', (ev) => {
  const r = ev.currentTarget.getBoundingClientRect();
  if (ev.target === ev.currentTarget && (ev.clientY < r.top || ev.clientY > r.bottom || ev.clientX < r.left || ev.clientX > r.right)) ev.currentTarget.close();
});

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
  $('winners-csv').href = api.winnersCsvUrl;
  const [rows, winners] = await Promise.all([run(() => api.adminRanking(sel.value)), run(api.adminPrizeWinners)]);
  if (rows) {
    const body = $('ranking'); clear(body);
    rows.forEach((r, i) => body.append(h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.score), h('td', {}, (r.durationMs / 1000).toFixed(1) + ' s'))));
    $('ranking-empty').hidden = rows.length > 0;
  }
  if (winners) {
    $('winners').replaceChildren(...winners.map((w) => {
      const what = w.kind === 'game' ? 'Premio de juegos' + (w.prize ? ' (' + (gameById(w.prize)?.name ?? w.prize) + ')' : '') : w.prize || 'Sorteo (sin nombre)';
      const done = w.deliveredAt ? 'Entregado ' + time(w.deliveredAt) : 'Pendiente';
      const mark = w.kind === 'raffle' && !w.deliveredAt && h('button', { type: 'button', className: 'b' }, 'Marcar entregado');
      if (mark) mark.onclick = async () => { if (await run(() => api.adminDeliverRaffle(w.id))) renderResults(); };
      return h('tr', {}, h('td', {}, w.name), h('td', {}, what), h('td', {}, time(w.at)), h('td', {}, done, mark && ' ', mark));
    }));
    $('winners-empty').hidden = winners.length > 0;
  }
}

// ---- Escenario: the LED wall behind the stage, driven like a vision mixer (plus the draw)
const SCENE_LABELS = { title: 'Título', ambient: 'Ambiente', speaker: 'Orador', award: 'Reconocimiento', raffle: 'Premios y sorteos', winner: 'Ganador', video: 'Video', black: 'Negro' };
const MIX = ['title', 'ambient', 'speaker', 'award', 'raffle', 'winner', 'video', 'black']; // keys 1-8 follow this order
let ST = null, stReady = false, spDraft = [], prizeTouched = false, stPending = 0, prizeOpts = [];
const OTHER = 'other';
async function loadStage(full) {
  if (!stReady) initStage();
  const [st, winners] = await Promise.all([run(api.adminStage), run(api.adminWinners)]);
  if (!st || !winners) return;
  ST = st;
  renderMixer(winners);
  renderRaffleMode();
  renderStrip();
  if (full) { spDraft = ST.speakers.map((x) => ({ ...x })); renderSpeakers(); $('st-awards').value = ST.awards.map((a) => a.company + (a.text ? ' | ' + a.text : '')).join('\n'); $('st-prize-list').value = ST.prizes.join('\n'); $('st-ambient').value = ST.ambient.join('\n'); $('st-video').value = ST.video; }
}
// Resolves true when the server accepted the change; the mixer is refreshed afterwards.
const setStage = async (patch) => {
  stPending++;
  try { const ok = !!(await run(() => api.adminSetStage(patch))); if (ok) await loadStage(); return ok; } finally { stPending--; }
};
const markOn = (scene) => {
  for (const b of $('st-mixer').children) { const on = b.dataset.scene === scene; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  const sp = ST.speakers[ST.speaker];
  const aw = ST.awards[ST.award];
  $('st-now').textContent = 'En pantalla: ' + SCENE_LABELS[scene] + (scene === 'speaker' && sp ? ` (${sp.name})` : scene === 'award' && aw ? ` (${aw.company})` : '');
};
function renderMixer(winners) {
  const sp = ST.speakers[ST.speaker], aw = ST.awards[ST.award], w = winners.find((x) => x.id === ST.winner && !x.voidedAt);
  const subs = {
    title: 'Digital Power - Gala 2026', ambient: 'Animaciones suaves que rotan', speaker: sp ? sp.name + (sp.role ? ' · ' + sp.role : '') : 'Sin oradores',
    award: aw ? aw.company + (aw.text ? ' · ' + aw.text : '') : 'Sin reconocimientos',
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
  const live = (k) => (ST.scene === k ? 'En pantalla · ' : 'Preparado · ');
  $('st-sp').textContent = sp ? `${live('speaker')}${ST.speaker + 1} de ${ST.speakers.length}: ${sp.name}` : 'Sin oradores';
  $('st-prev').disabled = ST.speaker <= 0;
  $('st-next').disabled = ST.speaker >= ST.speakers.length - 1;
  $('st-aw').textContent = aw ? `${live('award')}${ST.award + 1} de ${ST.awards.length}: ${aw.company}${aw.text ? ' · ' + aw.text : ''}` : 'Sin reconocimientos';
  $('st-aprev').disabled = ST.award <= 0;
  $('st-anext').disabled = ST.award >= ST.awards.length - 1;
  renderPrizes(winners.filter((x) => !x.voidedAt));
  if (changed('win', winners)) {
    $('st-winners').replaceChildren(...winners.map((x) => {
      const text = x.name + (x.prize ? ' · ' + x.prize : '') + ' · ' + time(x.drawnAt);
      if (x.voidedAt) return h('li', {}, h('s', {}, text), ' · anulado');
      const show = h('button', { type: 'button', className: 'b' }, 'Mostrar');
      show.onclick = () => setStage({ scene: 'winner', winner: x.id });
      const redo = h('button', { type: 'button', className: 'b' }, 'Anular y volver a sortear');
      redo.onclick = async () => {
        if (!confirm(`¿Anular el sorteo de ${x.name}${x.prize ? ' («' + x.prize + '»)' : ''}? Queda fuera de los próximos sorteos y el premio vuelve a estar disponible.`)) return;
        if (!(await run(() => api.adminVoidRaffle(x.id)))) return;
        toast('Sorteo anulado. Toca «Sortear ahora» para repetirlo.');
        loadRaffle(); prizeTouched = true;
        await loadStage();
        selectPrize(x.prize);
      };
      const li = h('li', {}, text, show, redo);
      li.dataset.id = x.id;
      return li;
    }));
  }
  for (const li of $('st-winners').children) li.classList.toggle('on', Number(li.dataset.id) === ST.winner);
  $('st-winners-empty').hidden = winners.length > 0;
}
// Prize picker: the configured list, awarded ones marked (a prize listed twice is awarded once per active winner); defaults to the first not yet awarded.
function renderPrizes(active) {
  const left = {};
  for (const w of active) left[w.prize] = (left[w.prize] || 0) + 1;
  const opts = ST.prizes.map((p) => { const done = left[p] > 0; if (done) left[p]--; return { p, done }; });
  const sel = $('st-prize'), cur = sel.value;
  if (changed('pz', opts)) {
    prizeOpts = opts;
    sel.replaceChildren(...opts.map((o, i) => h('option', { value: String(i) }, o.p + (o.done ? ' (ya sorteado)' : ''))), h('option', { value: OTHER }, 'Otro premio…'));
    if (prizeTouched && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }
  if (!prizeTouched && document.activeElement !== sel) {
    const next = opts.findIndex((o) => !o.done);
    sel.value = next < 0 ? OTHER : String(next);
  }
  $('st-prize-other').hidden = sel.value !== OTHER;
}
const prizeName = () => ($('st-prize').value === OTHER ? $('st-prize-other').value : prizeOpts[Number($('st-prize').value)]?.p ?? '').replace(/\s+/g, ' ').trim();
function selectPrize(prize) { // the voided prize is free again: pick it so the redraw is one click
  const i = prizeOpts.findIndex((o) => o.p === prize && !o.done);
  if (i >= 0) $('st-prize').value = String(i);
  else { $('st-prize').value = OTHER; $('st-prize-other').value = prize; }
  $('st-prize-other').hidden = $('st-prize').value !== OTHER;
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
    // Photo (optional): uploaded to the server, kept as a media/ path in the draft until "Guardar oradores".
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
    file.onchange = async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast('La foto supera 8 MB.', true);
      const r = await run(() => api.adminUploadImage(f));
      if (r) { x.photo = r.path; toast('Foto subida. Toca «Guardar oradores» para publicarla.'); renderSpeakers(); }
    };
    const pick = h('button', { type: 'button', className: 'b' }, x.photo ? 'Cambiar foto' : 'Foto');
    pick.onclick = () => file.click();
    const drop = x.photo && h('button', { type: 'button', className: 'b' }, 'Quitar foto');
    if (drop) drop.onclick = () => { delete x.photo; renderSpeakers(); };
    return h('div', { className: 'st-spitem' },
      h('div', { className: 'st-sprow' }, name, role, move('↑', -1, 'Subir'), move('↓', 1, 'Bajar'), del),
      h('div', { className: 'st-spphoto' }, x.photo && h('img', { src: new URL(x.photo, location.href).href, alt: 'Foto de ' + (x.name || 'orador ' + (i + 1)) }), pick, drop, file));
  }));
}
// Sorteo: the winner line mirrors what the panels are showing; "Ocultar" takes it off the screens.
const showRaffle = (name) => { $('winner').textContent = name || ''; };
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
  // Prev/next only pick who is next: the screen changes when that scene is on air (or when its tile is pressed).
  $('st-prev').onclick = () => setStage({ speaker: ST.speaker - 1 });
  $('st-next').onclick = () => setStage({ speaker: ST.speaker + 1 });
  $('st-aprev').onclick = () => setStage({ award: ST.award - 1 });
  $('st-anext').onclick = () => setStage({ award: ST.award + 1 });
  $('st-cue').onclick = async () => {
    const b = $('st-cue'); b.disabled = true; // a second tap would restart the cue
    if (!(await run(api.adminCue))) { b.disabled = false; return; }
    toast('Momento WOW'); loadStage();
    b.textContent = 'WOW en curso…';
    setTimeout(() => { b.textContent = 'Momento WOW'; b.disabled = false; }, 5000); // lead + sweep across the 4 panels and the stage
  };
  $('st-prize').onchange = () => { prizeTouched = true; $('st-prize-other').hidden = $('st-prize').value !== OTHER; if (!$('st-prize-other').hidden) $('st-prize-other').focus(); };
  $('st-draw').onclick = async () => {
    const prize = prizeName();
    if (!confirm(`¿Sortear ${prize ? '«' + prize + '»' : 'un premio sin nombre'}? La pantalla LED y los 4 paneles empiezan el sorteo ahora.`)) return;
    const b = $('st-draw'); b.disabled = true;
    const w = await run(() => api.adminRaffle(prize));
    b.disabled = false;
    if (!w) return;
    toast('Ganador: ' + w.name); showRaffle(w.name);
    prizeTouched = false;
    refresh(); loadStage();
  };
  $('hide-raffle').onclick = async () => { if (await run(api.adminClearRaffle)) { toast('Pantallas limpias: placa de premios sin nombre'); showRaffle(''); loadStage(); } };
  $('reset-raffle').onclick = async () => {
    if (!confirm('Se borran todos los sorteos hechos, incluidos los de prueba. No se puede deshacer.')) return;
    const r = await run(api.adminResetRaffle);
    if (!r) return;
    toast(`Sorteos borrados (${r.deleted})`); showRaffle(''); prizeTouched = false; refresh(); loadStage();
  };
  $('raffle-mode').onclick = async () => { if (await setting({ raffleMode: !S.settings.raffleMode })) renderRaffleMode(); };
  $('st-add').onclick = () => { spDraft.push({ name: '', role: '' }); renderSpeakers(); $('st-speakers').lastChild.querySelector('input').focus(); };
  $('st-save-sp').onclick = async () => {
    const speakers = spDraft.map((x) => ({ name: x.name.trim(), role: x.role.trim(), ...(x.photo ? { photo: x.photo } : {}) })).filter((x) => x.name);
    if (await run(() => api.adminSetStage({ speakers }))) { toast('Oradores guardados'); loadStage(true); }
  };
  $('st-save-aw').onclick = async () => {
    const awards = $('st-awards').value.split('\n').map((l) => { const i = l.indexOf('|'); return i < 0 ? { company: l.trim(), text: '' } : { company: l.slice(0, i).trim(), text: l.slice(i + 1).trim() }; }).filter((a) => a.company);
    if (awards.length > 60) return toast('Máximo 60 reconocimientos.', true);
    if (awards.some((a) => a.company.length > 80 || a.text.length > 120)) return toast('La empresa admite hasta 80 caracteres y el texto hasta 120.', true);
    if (await run(() => api.adminSetStage({ awards }))) { toast('Reconocimientos guardados'); loadStage(true); }
  };
  $('st-save-amb').onclick = async () => {
    const ambient = $('st-ambient').value.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (ambient.length > 20) return toast('Máximo 20 frases.', true);
    if (ambient.some((x) => x.length > 80)) return toast('Cada frase puede tener hasta 80 caracteres.', true);
    if (await run(() => api.adminSetStage({ ambient }))) { toast('Frases guardadas'); $('st-ambient').value = ambient.join('\n'); loadStage(); }
  };
  $('st-upload').onclick = async () => {
    const f = $('st-file').files[0], msg = $('st-upload-msg'), bar = $('st-progress'), b = $('st-upload');
    if (!f) return toast('Elige primero un archivo MP4.', true);
    if (f.size > 500 * 1024 * 1024) { msg.textContent = 'El archivo supera 500 MB.'; return toast(msg.textContent, true); }
    b.disabled = true; bar.hidden = false; bar.value = 0; msg.textContent = 'Subiendo… 0 %';
    try {
      const r = await api.adminUploadMedia(f, (p) => { bar.value = Math.round(p * 100); msg.textContent = `Subiendo… ${Math.round(p * 100)} %`; });
      msg.textContent = `Video subido (${(r.size / 1e6).toFixed(1)} MB) y puesto en la escena de video.`;
      toast('Video subido'); $('st-video').value = r.video; $('st-file').value = ''; loadStage();
    } catch (e) {
      if (e.code === 'unauthorized') { toast('Sesión vencida', true); showLogin(); }
      msg.textContent = e.code === 'unauthorized' ? '' : e.status === 413 || e.code === 'too_large' ? 'El archivo supera 500 MB.'
        : e.code === 'invalid_mp4' ? 'El archivo no es un MP4 válido.' : e.code === 'network' ? 'Se cortó la conexión durante la subida. Inténtalo de nuevo.' : 'No se pudo subir el video.';
      if (msg.textContent) toast(msg.textContent, true);
    } finally { b.disabled = false; bar.hidden = true; }
  };
  $('st-save').onclick = async () => {
    const prizes = $('st-prize-list').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (prizes.some((x) => x.length > 80)) return toast('Cada premio puede tener hasta 80 caracteres.', true);
    if (await run(() => api.adminSetStage({ prizes, video: $('st-video').value.trim() }))) { toast('Premios y video guardados'); prizeTouched = false; loadStage(true); }
  };
}
// Mixer refresh: every 3 s while the Escenario tab is open (another operator may switch plates too); never mid-change.
setInterval(() => { if (current === 'stage' && !document.hidden && !$('app').hidden && !stPending) loadStage(); }, 3000);
// Keyboard on Escenario only: 1-8 scenes (mixer order), arrows award prev/next while an award is on screen, speaker otherwise. Deliberately none for WOW or the draw.
addEventListener('keydown', (ev) => {
  if (current !== 'stage' || $('app').hidden || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const aw = ST?.scene === 'award';
  const btn = /^[1-8]$/.test(ev.key) ? $('st-mixer').children[ev.key - 1] : ev.key === 'ArrowLeft' ? $(aw ? 'st-aprev' : 'st-prev') : ev.key === 'ArrowRight' ? $(aw ? 'st-anext' : 'st-next') : null;
  if (btn && !btn.disabled) { ev.preventDefault(); btn.click(); }
});

// ---- Wiring
async function boot() {
  let dark = true;
  try { dark = localStorage.getItem('fiesta.admin.dark') !== '0'; } catch {}
  setTheme(dark);
  if (api.isDemo) { $('demo').hidden = false; return; }
  $('login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const me = await run(async () => { await api.adminLogin($('pw').value); return api.adminMe(); });
    if (me) enter(me.role);
  };
  $('logout').onclick = async () => { if (confirm('¿Salir del panel?')) { await run(api.adminLogout); showLogin(); } };
  $('theme').onclick = () => setTheme(!document.body.classList.contains('dark'));
  $('paused').onchange = async (ev) => {
    if (ev.target.checked && !confirm('¿Pausar los 4 paneles de juego? Nadie podrá jugar hasta que lo reactives.')) { ev.target.checked = false; return; }
    if (!(await setting({ paused: ev.target.checked }))) renderLive(); // failed: back to the server value
  };
  $('trans').onchange = async (ev) => { if (!(await setting({ transition: ev.target.checked }))) renderLive(); };
  $('trans-save').onclick = () => setting({ transitionText: $('trans-text').value }).then((r) => r && toast('Texto guardado'));
  $('guests-example').href = api.guestsExampleUrl;
  $('guests-csv').href = api.guestsCsvUrl;
  $('verif-new').onclick = loadVerifs;
  $('ag-from-q').onclick = () => { $('ag-name').value = $('gq').value.trim(); $('add-box').open = true; $('ag-name').focus(); };
  $('add-guest').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $('ag-name').value.trim();
    const r = await run(() => api.adminAddGuest({ name, email: $('ag-email').value.trim() }));
    if (!r) return;
    ev.target.reset(); $('add-box').open = false; $('gq').value = name; gFilter = 'all'; lastAct = `${name} agregado ${time(Date.now())}`;
    await loadGuests(); $('gq').scrollIntoView({ block: 'start' });
  };
  $('gq').oninput = () => { clearTimeout(gTimer); gTimer = setTimeout(loadGuests, 300); };
  $('csv').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    if (f.size > 5_242_880) { ev.target.value = ''; return toast('El archivo supera 5 MB.', true); }
    const r = await run(() => api.adminImportGuests(f));
    ev.target.value = '';
    if (r) { toast(`${r.added} nuevos, total ${r.total}`); $('import-box').open = false; loadGuests(); }
  };
  $('stock-save').onclick = async () => {
    const n = $('stock').valueAsNumber;
    if (!Number.isInteger(n) || n < 0) return toast('Ingresa un stock válido.', true);
    if (await setting({ prizeStock: n })) { await refresh(); renderStock(); toast('Stock guardado'); }
  };
  $('rank-game').onchange = renderResults;

  try { enter((await api.adminMe()).role); } catch (e) { if (e.code === 'unauthorized') showLogin(); else { showLogin(); toast(ERRORS[e.code] || 'Ocurrió un error inesperado.', true); } }
}
boot();
