import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { search, register, ticketHref } from './api.js';
import { $, RM, demoBadge, cleanName } from './common.js';

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });
gsap.ticker.lagSmoothing(0); // follow the real clock on slow devices: animations may skip frames but always finish on time
demoBadge();

const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const hero = $('.hero'), curtain = $('#curtain');
const seen = document.documentElement.classList.contains('seen');
try { sessionStorage.setItem('gala.intro', '1'); } catch {}
try { localStorage.setItem('gala.theme', document.documentElement.classList.contains('noche') ? 'noche' : ''); } catch {} // ticket follows the invitation's theme
const maskOk = CSS.supports('mask-image', 'radial-gradient(#000,#000)') || CSS.supports('-webkit-mask-image', 'radial-gradient(#000,#000)');

// ---------- split text into letters ----------
const split = (el) => { el.innerHTML = [...el.textContent].map((c) => `<span class="ch" aria-hidden="true">${c === ' ' ? '&nbsp;' : c}</span>`).join(''); return $$('.ch', el); };
$$('[data-split]').forEach(split);
const cjkChars = split($('.cjk'));
$('.cjk').setAttribute('aria-label', '共创更美好的未来');

// ---------- petals ----------
const rnd = (a, b) => a + Math.random() * (b - a);
$('#petals').innerHTML = Array.from({ length: 12 }, () =>
  `<i style="--x:${rnd(2, 96).toFixed(1)}%;--s:${rnd(8, 15).toFixed(1)}px;--t:${rnd(14, 24).toFixed(1)}s;--d:${(-rnd(0, 24)).toFixed(1)}s;--dx:${rnd(-60, 70).toFixed(0)}px;--r:${rnd(120, 420).toFixed(0)}deg"></i>`).join('');

// ---------- entrance: curtain -> ink wash -> staggered hero (transform/opacity only) ----------
const CP = { clearProps: 'transform,opacity' };
function intro() {
  if (RM) { curtain.remove(); document.documentElement.classList.add('go'); gsap.from(hero, { opacity: 0, duration: 0.4, ...CP }); return; }
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  let t = 0;
  if (seen) curtain.remove();
  else {
    gsap.set(curtain, { '--r': '0%' });
    tl.from('.curtain svg', { opacity: 0, y: 14, scale: 0.85, duration: 0.55, ease: 'power2.out' }, 0)
      .to('.curtain svg', { opacity: 0, scale: 1.15, duration: 0.35, ease: 'power2.in' }, 0.7)
      .to(curtain, maskOk ? { '--r': '150%', duration: 1.2, ease: 'power2.inOut' } : { opacity: 0, duration: 0.7, ease: 'power1.inOut' }, 0.75)
      .set(curtain, { display: 'none' });
    t = 0.75;
  }
  tl.add(() => document.documentElement.classList.add('go'), t)
    .from('.art img', { opacity: 0, scale: 1.08, transformOrigin: '50% 0', duration: 1.6, ease: 'power2.out', ...CP }, t)
    .from('.px-sun', { opacity: 0, duration: 1.4, ...CP }, t + 0.2)
    .from('.px-petals', { opacity: 0, duration: 1.6, ...CP }, t + 0.6)
    .from($$('.eyebrow'), { y: 12, opacity: 0, duration: 0.8, ...CP }, t + 0.2)
    .from($$('.title .ch'),{ y: 40, opacity: 0, duration: 1, stagger: 0.07, ...CP }, t + 0.35)
    .from('.tag', { y: 18, opacity: 0, duration: 0.9, ...CP }, t + 1.0)
    .from('.knot .kl', { scaleX: 0, transformOrigin: '100% 50%', duration: 0.8, ease: 'power2.out', ...CP }, t + 1.15)
    .from('.knot .kr', { scaleX: 0, transformOrigin: '0% 50%', duration: 0.8, ease: 'power2.out', ...CP }, t + 1.15)
    .from('.knot .kc', { scale: 0, opacity: 0, transformOrigin: '50% 50%', duration: 0.6, ease: 'back.out(1.8)', ...CP }, t + 1.05)
    .from('.invite', { y: 18, opacity: 0, duration: 0.9, ...CP }, t + 1.3)
    .from('.info li', { y: 24, opacity: 0, duration: 0.8, stagger: 0.14, ...CP }, t + 1.5)
    .from('.cta', { y: 20, scale: 0.94, opacity: 0, duration: 0.8, ...CP }, t + 1.95)
    .from('.mine', { opacity: 0, duration: 0.6, ...CP }, t + 2.2);
  if (seen) tl.timeScale(1.8);
  // the invitation must never stay hidden behind a stalled entrance (throttled tab, low-power mode)
  setTimeout(() => { if (tl.progress() < 1) { tl.progress(1); curtain.remove(); } }, 4500);
}
intro();

// ---------- hero parallax: layers drift at different speeds while the hero leaves ----------
if (!RM) {
  const H = () => hero.offsetHeight;
  const st = { trigger: hero, start: 'top top', end: 'bottom top', scrub: true, invalidateOnRefresh: true };
  const px = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: st });
  px.to('.art img', { y: () => H() * 0.3 }, 0)          // background: slowest
    .to('.px-sun', { y: () => H() * 0.18 }, 0)
    .to('.px-waves', { y: () => H() * 0.12 }, 0)
    .to('.px-petals', { y: () => -H() * 0.2 }, 0)       // petals: fastest
    .to('.title', { y: () => -H() * 0.1, scale: 0.95, opacity: 0.1, transformOrigin: '50% 100%' }, 0);
}

// ---------- scroll reveals (simple fades under reduced motion) ----------
const reveal = (el, from = {}, st = {}) => gsap.from(el, {
  opacity: 0, ...(RM ? {} : from), duration: RM ? 0.5 : 0.9, ease: 'power3.out', ...CP,
  scrollTrigger: { trigger: st.trigger || el, start: 'top 86%', once: true },
});

$$('.sec h2').forEach((h) => {
  const rule = document.createElement('i');
  rule.className = 'rule'; rule.setAttribute('aria-hidden', 'true');
  h.after(rule);
  reveal(h, { y: 22 });
  reveal(rule, { scaleX: 0, transformOrigin: '50% 50%' }, { trigger: h });
});

// timeline: red/gold line draws with scroll, items arrive as it reaches them
const tl = $('.tl');
const line = document.createElement('span');
line.className = 'tl-line'; line.setAttribute('aria-hidden', 'true');
tl.prepend(line);
if (!RM) {
  gsap.fromTo(line, { scaleY: 0 }, { scaleY: 1, ease: 'none', scrollTrigger: { trigger: tl, start: 'top 72%', end: 'bottom 62%', scrub: true } });
}
$$('.tl li').forEach((li) => {
  reveal(li, {}, { trigger: li });
  if (!RM) {
    gsap.from($('time', li), { x: -26, duration: 0.9, ease: 'power3.out', ...CP, scrollTrigger: { trigger: li, start: 'top 80%', once: true } });
    gsap.from($('p', li), { x: 26, duration: 0.9, ease: 'power3.out', ...CP, scrollTrigger: { trigger: li, start: 'top 80%', once: true } });
  }
});

reveal('.where', { y: 44, scale: 0.97 });
reveal('.lead', { y: 16 });
reveal('.reg > .card', { y: 36 });
gsap.from(cjkChars, { opacity: 0, y: RM ? 0 : 10, duration: RM ? 0.5 : 0.7, stagger: RM ? 0 : 0.14, ease: 'power2.out', ...CP, scrollTrigger: { trigger: '.foot', start: 'top 92%', once: true } });
reveal('.slogan', { y: 8 }, { trigger: '.foot' });

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
