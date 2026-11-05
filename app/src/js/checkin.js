import { isDemo, checkinInfo, checkinAction } from './api.js';
import { $, demoBadge, cleanName } from './common.js';

demoBadge();

const token = new URLSearchParams(location.search).get('c') || '';
const hm = (t) => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const ERR = {
  already_checked_in: 'Esta persona ya estaba acreditada.',
  no_prize: 'Esta persona no ganó premio.',
  already_delivered: 'El premio ya fue entregado.',
  unauthorized: 'Tu sesión de staff venció. Ingresa de nuevo.',
};

const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
};

function render(d) {
  $('#who').textContent = cleanName(d.name);
  const staff = 'checkedInAt' in d;
  const status = $('#status'), acts = $('#acts');
  status.replaceChildren(); acts.replaceChildren();
  $('#staff').hidden = staff || isDemo;
  if (!staff) { $('#line').textContent = 'Presenta este código en la entrada.'; return; }
  $('#line').textContent = '';

  status.append(el('p', d.checkedInAt ? `Acreditado ${hm(d.checkedInAt)}` : 'Sin acreditar', d.checkedInAt ? 'ok' : ''));
  if (!d.checkedInAt) acts.append(act('Acreditar', 'checkin'));
  if (d.prizeDeliveredAt) status.append(el('p', `Premio entregado ${hm(d.prizeDeliveredAt)}`, 'ok'));
  else if (d.prizeWonAt) acts.append(act('Entregar premio', 'deliver'));
  else status.append(el('p', 'Sin premio'));
}

function act(label, action) {
  const b = el('button', label, 'btn');
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true; $('#msg').textContent = '';
    try { render(await checkinAction(token, action)); }
    catch (e) {
      if (e.code === 'unauthorized' && !isDemo) $('#staff').hidden = false;
      $('#msg').textContent = ERR[e.code] || 'No se pudo completar. Inténtalo de nuevo.';
      if (e.code === 'already_checked_in' || e.code === 'already_delivered' || e.code === 'no_prize') load(); // resync
      else b.disabled = false;
    }
  });
  return b;
}

async function load() {
  try {
    const d = await checkinInfo(token);
    if (!d) { $('#who').textContent = 'Ticket no encontrado'; $('#line').textContent = ''; return; }
    render(d);
  } catch { $('#line').textContent = 'No hay conexión. Inténtalo de nuevo.'; }
}

// Same-origin relative link only; admin.js validates `next` too.
const here = location.pathname.split('/').pop() + location.search;
$('#staff').href = 'admin.html?next=' + encodeURIComponent(here);
load();
