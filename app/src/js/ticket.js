import gsap from 'gsap';
import confetti from 'canvas-confetti';
import QRCode from 'qrcode';
import { ticket, checkinUrl } from './api.js';
import { $, RM, demoBadge, cleanName, vibrate } from './common.js';

demoBadge();

const token = new URLSearchParams(location.search).get('t') || '';
const openedKey = 'fiesta.opened.' + token;
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function ticketPng(d, qr) {
  try { await Promise.all([document.fonts.load('300 60px "Cormorant Garamond"'), document.fonts.load('600 60px "Cormorant Garamond"'), document.fonts.load('500 24px Montserrat')]); } catch {}
  const W = 900, H = 1260, serif = '"Cormorant Garamond", Georgia, serif', sans = 'Montserrat, sans-serif';
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const x = c.getContext('2d');
  x.fillStyle = '#F7F1E8'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#C9A45C'; x.lineWidth = 3; x.strokeRect(36, 36, W - 72, H - 72);
  x.lineWidth = 1.5; x.strokeRect(52, 52, W - 104, H - 104);
  x.textAlign = 'center';
  x.fillStyle = '#C8102E'; x.font = `300 76px ${serif}`;
  if ('letterSpacing' in x) x.letterSpacing = '12px';
  x.fillText('GALA HUAWEI DIGITAL POWER 2026', W / 2 + 6, 170, W - 160);
  if ('letterSpacing' in x) x.letterSpacing = '0px';
  x.fillStyle = '#2E2A28'; x.font = `500 56px ${serif}`; x.fillText(cleanName(d.name), W / 2, 250, W - 160);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.replace('<svg ', '<svg width="520" height="520" '));
  await img.decode();
  x.fillStyle = '#F7F1E8'; x.fillRect(190, 300, 520, 520);
  x.drawImage(img, 190, 300, 520, 520);
  x.fillStyle = '#6B6460'; x.font = `500 24px ${sans}`;
  if ('letterSpacing' in x) x.letterSpacing = '8px';
  x.fillText('TU PIN', W / 2 + 4, 890);
  if ('letterSpacing' in x) x.letterSpacing = '14px';
  x.fillStyle = '#9E1B22'; x.font = `600 140px ${serif}`; x.fillText(d.pin, W / 2 + 7, 1020);
  if ('letterSpacing' in x) x.letterSpacing = '0px';
  x.fillStyle = '#2E2A28'; x.font = `500 26px ${sans}`;
  x.fillText('Lunes 30 de noviembre de 2026 · 19:00 H', W / 2, 1090);
  x.fillText('Puerto Salguero, Costanera Rafael Obligado 1221, CABA', W / 2, 1130, W - 160);
  x.fillStyle = '#6B6460'; x.font = `400 22px ${sans}`;
  x.fillText('Muestra este QR al llegar. Tu PIN es tu llave para los juegos.', W / 2, 1180, W - 160);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

// Plum petals: ~55 pink/red petals + a few gold flecks, once.
function burst() {
  try {
    const r = $('#t').getBoundingClientRect();
    const origin = { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height * 0.25) / innerHeight };
    const petal = confetti.shapeFromPath({ path: 'M0 0C4-7 13-7 16 0 13 7 4 7 0 0Z' });
    confetti({ particleCount: 52, origin, spread: 100, startVelocity: 26, gravity: 0.55, decay: 0.92, drift: 0.4, ticks: 210, scalar: 1.7, shapes: [petal], colors: ['#F2A7B0', '#F7C3C9', '#E85A6E', '#C8102E'], disableForReducedMotion: true });
    confetti({ particleCount: 8, origin, spread: 80, startVelocity: 22, gravity: 0.6, ticks: 180, scalar: 0.7, shapes: ['circle'], colors: ['#C9A45C', '#E3C987'], disableForReducedMotion: true });
  } catch {}
}

// Hongbao -> ticket (~2.4 s). Reduced motion: 200 ms fade only.
function openEnvelope(digits) {
  $('#env').disabled = true;
  vibrate(15);
  const t = $('#t');
  t.hidden = false;
  if (RM) {
    $('#sealed').hidden = true;
    gsap.from(t, { opacity: 0, duration: 0.2 });
    finish();
    return;
  }
  gsap.set(t, { y: 120, scale: 0.6, opacity: 0 });
  gsap.set('#qr', { opacity: 0 });
  gsap.set(digits, { opacity: 0, y: 10 });
  gsap.timeline({ onComplete: finish })
    .to('.seal', { scale: 0.2, opacity: 0, duration: 0.25, ease: 'power2.in' }, 0)
    .to('.flap', { rotateX: 180, duration: 0.55, ease: 'power2.inOut' }, 0.1)
    .to(t, { y: 0, scale: 1, opacity: 1, duration: 0.9, ease: 'power3.out' }, 0.45)
    .to('#sealed', { y: 140, opacity: 0, duration: 0.6, ease: 'power2.in' }, 0.9)
    .set('#sealed', { display: 'none' })
    .set('.sheen', { opacity: 1, xPercent: -120 }, 1.4)
    .to('.sheen', { xPercent: 120, duration: 1, ease: 'power1.inOut' }, 1.4)
    .to('#qr', { opacity: 1, duration: 0.5 }, 1.5)
    .call(burst, [], 1.35)
    .to(digits, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.09 }, 1.7);
}

function finish() {
  set(openedKey, '1');
  $('#dl').hidden = false;
}

try {
  const d = await ticket(token);
  if (!d) throw new Error('not_found');
  const qr = await QRCode.toString(checkinUrl(d.checkinToken), { type: 'svg', margin: 1, color: { dark: '#2E2A28', light: '#F7F1E8' } });
  $('#name').textContent = cleanName(d.name);
  $('#qr').innerHTML = qr;
  $('#pin').innerHTML = [...d.pin].map((c) => `<span>${c}</span>`).join('');
  set('fiesta.ticket', `ticket.html?t=${encodeURIComponent(token)}`);
  const digits = [...document.querySelectorAll('#pin span')];

  $('#reveal').hidden = false;
  $('#dl').addEventListener('click', async () => {
    try { save(await ticketPng(d, qr), 'invitacion-gala-huawei-2026.png'); }
    catch { save(new Blob([qr], { type: 'image/svg+xml' }), 'invitacion-gala-huawei-2026-qr.svg'); }
  });

  if (get(openedKey)) { // returning visitor: straight to the ticket
    $('#sealed').hidden = true; $('#t').hidden = false;
    finish();
  } else {
    $('#env').addEventListener('click', () => openEnvelope(digits), { once: true });
  }
} catch {
  $('#reveal').hidden = true;
  $('#nf').hidden = false;
}
