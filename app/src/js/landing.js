import { search, register, ticketHref } from './api.js';
import { $, RM, demoBadge, cleanName } from './common.js';

demoBadge();

// ---------- hero: split title into letters, drift petals ----------
let n = 0;
document.querySelectorAll('[data-split]').forEach((el) => {
  el.innerHTML = [...el.textContent].map((c) => `<span class="ch" aria-hidden="true" style="--i:${n++}">${c}</span>`).join('');
});
requestAnimationFrame(() => $('#title').classList.add('go'));

const rnd = (a, b) => a + Math.random() * (b - a);
$('#petals').innerHTML = Array.from({ length: 12 }, () =>
  `<i style="--x:${rnd(2, 96).toFixed(1)}%;--s:${rnd(8, 15).toFixed(1)}px;--t:${rnd(14, 24).toFixed(1)}s;--d:${(-rnd(0, 24)).toFixed(1)}s;--dx:${rnd(-60, 70).toFixed(0)}px;--r:${rnd(120, 420).toFixed(0)}deg"></i>`).join('');

// ---------- sections fade up as they enter ----------
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));

try {
  const t = localStorage.getItem('fiesta.ticket');
  if (t) { $('#mine').href = t; $('#mine').hidden = false; }
} catch {}

// ---------- search ----------
const list = $('#results'), hint = $('#hint'), errEl = $('#err');
let picked = null, timer, seq = 0;
const showErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

function rowHtml(g) {
  const name = cleanName(g.name);
  return `<button type="button" class="row-btn"><span class="av">${name[0].toUpperCase()}</span><span>${name}</span>${g.registered ? '<small>Ya inscrito</small>' : ''}</button>`;
}

async function doSearch(q) {
  q = q.trim();
  const mine = ++seq;
  list.replaceChildren();
  if (q.length < 3) { hint.textContent = 'Escribe al menos 3 letras.'; return; }
  try {
    const rows = await search(q);
    if (mine !== seq) return;
    hint.textContent = rows.length ? 'Toca tu nombre' : 'No te encontramos. Prueba con tu apellido.';
    for (const g of rows) {
      const li = document.createElement('li');
      li.innerHTML = rowHtml(g);
      if (!RM) li.classList.add('fade');
      li.firstChild.addEventListener('click', () => pick(g, li));
      list.append(li);
    }
  } catch (e) {
    if (mine !== seq) return;
    hint.textContent = '';
    showErr(e.code === 'rate_limited' ? 'Demasiadas búsquedas. Espera unos segundos.' : 'No se pudo buscar. Revisa tu conexión e inténtalo de nuevo.');
  }
}
$('#q').addEventListener('input', (e) => { showErr(''); clearTimeout(timer); timer = setTimeout(() => doSearch(e.target.value), 250); });

function swap(confirming) {
  $('#step-search').hidden = confirming;
  $('#step-confirm').hidden = !confirming;
  if (confirming && !RM) $('#step-confirm').animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'ease-out' });
}
function pick(g, li) {
  picked = g; showErr('');
  $('#slot').replaceChildren(li);
  $('#who').textContent = `¿Eres ${cleanName(g.name)}?`;
  swap(true);
}
$('#no').addEventListener('click', () => { picked = null; swap(false); doSearch($('#q').value); });

$('#yes').addEventListener('click', async () => {
  if (!picked) return;
  const b = $('#yes');
  b.disabled = true; b.classList.add('busy');
  try {
    const { ticketToken } = await register(picked.id);
    const href = ticketHref(ticketToken);
    try { localStorage.setItem('fiesta.ticket', href); } catch {}
    b.classList.replace('busy', 'done');
    setTimeout(() => { location.href = href; }, RM ? 0 : 650);
  } catch (e) {
    b.classList.remove('busy'); b.disabled = false;
    if (e.code === 'already_registered') { showErr(e.message); picked = null; swap(false); doSearch($('#q').value); }
    else showErr('No se pudo completar la inscripción. Inténtalo de nuevo.');
  }
});
