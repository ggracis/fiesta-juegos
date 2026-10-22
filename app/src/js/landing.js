import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import { Flip } from 'gsap/Flip';
import { search, register, ticketHref } from './api.js';
import { $, RM, injectSprite, mascot, avatar, demoBadge, firstName, cleanName } from './common.js';

gsap.registerPlugin(SplitText, Flip);
injectSprite();
demoBadge();

$('#trio').innerHTML = [
  mascot({ h: 350, shape: 'tall', acc: 'hat' }),
  mascot({ h: 12, shape: 'round', acc: 'antenna' }),
  mascot({ h: 330, shape: 'box', acc: 'bow' }),
].map((m) => `<span>${m}</span>`).join('');

// ---------- hero intro: one orchestrated moment ----------
async function intro() {
  const h1 = $('#h1'), sub = $('#sub');
  if (RM) { gsap.set([h1, sub], { opacity: 1 }); return; }
  try { await document.fonts.ready; } catch {}
  const split = SplitText.create(h1, { type: 'words', mask: 'words' });
  gsap.set(h1, { opacity: 1 });
  gsap.timeline()
    .from(split.words, { yPercent: 110, duration: 0.7, ease: 'power4.out', stagger: 0.09 })
    .from('#trio > span', { y: 160, scale: 0.6, duration: 0.8, ease: 'back.out(1.8)', stagger: 0.08 }, 0.2)
    .to(sub, { opacity: 1, duration: 0.5 }, 0.7);
}
intro().catch(() => gsap.set(['#h1', '#sub'], { opacity: 1 }));

// ---------- sticky CTA hides while the form is on screen ----------
new IntersectionObserver(([e]) => $('#cta').classList.toggle('off', e.isIntersecting), { threshold: 0.2 }).observe($('#reg'));

try {
  const t = localStorage.getItem('fiesta.ticket');
  if (t) { $('#mine').href = t; $('#mine').hidden = false; }
} catch {}

// ---------- search ----------
const list = $('#results'), hint = $('#hint'), errEl = $('#err');
let picked = null, timer, seq = 0;
const showErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

function rowHtml(g) {
  return `<button type="button" class="row-btn">${avatar(g.name)}<span>${cleanName(g.name)}</span>${g.registered ? '<small>Ya inscrito</small>' : ''}</button>`;
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
      li.firstChild.addEventListener('click', () => pick(g, li));
      list.append(li);
    }
    if (!RM) gsap.from(list.children, { y: 14, opacity: 0, duration: 0.3, stagger: 0.04, ease: 'power2.out' });
  } catch (e) {
    if (mine !== seq) return;
    hint.textContent = '';
    showErr(e.code === 'rate_limited' ? 'Demasiadas búsquedas. Espera unos segundos.' : 'No se pudo buscar. Revisa tu conexión e inténtalo de nuevo.');
  }
}
$('#q').addEventListener('input', (e) => { showErr(''); clearTimeout(timer); timer = setTimeout(() => doSearch(e.target.value), 250); });

// ---------- tap a row: it expands into the confirm card (Flip) ----------
function swap(confirming) {
  $('#step-search').hidden = confirming;
  $('#step-confirm').hidden = !confirming;
}
function pick(g, li) {
  picked = g; showErr('');
  const state = Flip.getState(li);
  $('#slot').replaceChildren(li);
  swap(true);
  $('#who').textContent = `Hola, ${firstName(g.name)}. ¿Eres tú?`;
  if (!RM) Flip.from(state, { duration: 0.45, ease: 'power3.out', absolute: true });
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
