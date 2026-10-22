import gsap from 'gsap';
import confetti from 'canvas-confetti';
import QRCode from 'qrcode';
import { ticket, checkinUrl } from './api.js';
import { $, RM, injectSprite, demoBadge, cleanName, vibrate } from './common.js';

injectSprite();
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
  const W = 900, H = 1240;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#E4002B'); g.addColorStop(1, '#FF8A3D');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = '#fff'; x.beginPath(); x.roundRect(50, 50, W - 100, H - 100, 48); x.fill();
  x.textAlign = 'center'; x.fillStyle = '#2B0B12';
  x.font = '800 56px Outfit, sans-serif'; x.fillText(cleanName(d.name), W / 2, 160, W - 160);
  x.font = '500 30px Outfit, sans-serif'; x.fillStyle = '#6E3A45';
  x.fillText('Fiesta de fin de año · 30 de noviembre de 2026', W / 2, 215, W - 160);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.replace('<svg ', '<svg width="640" height="640" '));
  await img.decode();
  x.drawImage(img, 130, 260, 640, 640);
  x.font = '600 34px Outfit, sans-serif'; x.fillStyle = '#6E3A45'; x.fillText('Tu PIN es tu llave en las pantallas', W / 2, 990);
  x.font = '800 130px Outfit, sans-serif'; x.fillStyle = '#E4002B'; x.fillText(d.pin.split('').join(' '), W / 2, 1120);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

function burst() {
  const r = $('#t').getBoundingClientRect();
  confetti({
    particleCount: 70, spread: 80, startVelocity: 38, ticks: 160, scalar: 0.9, disableForReducedMotion: true,
    origin: { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height * 0.3) / innerHeight },
    colors: ['#FFC14D', '#FF8A3D', '#FF5A4D', '#FF2D8A', '#FFF7F3'],
  });
}

// Envelope -> ticket sequence (~2.4 s). Reduced motion: 200 ms fade only.
function openEnvelope(digits) {
  $('#env').disabled = true;
  vibrate(20);
  const t = $('#t');
  t.hidden = false;
  if (RM) {
    $('#sealed').hidden = true;
    gsap.from(t, { opacity: 0, duration: 0.2 });
    finish();
    return;
  }
  gsap.set(t, { y: 90, scale: 0.7, opacity: 0, position: 'relative' });
  gsap.set('#qr', { opacity: 0 });
  gsap.set(digits, { rotateX: -90, opacity: 0 });
  gsap.timeline({ onComplete: finish })
        .to('.flap', { rotateX: 180, duration: 0.4, ease: 'power2.inOut' }, 0)
    .to(t, { y: 0, scale: 1, opacity: 1, duration: 0.75, ease: 'back.out(1.6)' }, 0.3)
    .to('#sealed', { y: 120, opacity: 0, duration: 0.5, ease: 'power2.in' }, 0.7)
    .set('#sealed', { display: 'none' })
    .set('.sheen', { opacity: 1, xPercent: -120 }, 1.0)
    .to('.sheen', { xPercent: 120, duration: 0.9, ease: 'power1.inOut' }, 1.0)
    .to('#qr', { opacity: 1, duration: 0.4 }, 1.3)
    .call(burst, [], 1.2)
    .to(digits, { rotateX: 0, opacity: 1, duration: 0.35, ease: 'back.out(2)', stagger: 0.09 }, 1.45);
}

function finish() {
  set(openedKey, '1');
  $('#dl').hidden = false; $('#note').hidden = false;
}

try {
  const d = await ticket(token);
  if (!d) throw new Error('not_found');
  const qr = await QRCode.toString(checkinUrl(d.checkinToken), { type: 'svg', margin: 1, color: { dark: '#2B0B12', light: '#FFFFFF' } });
  $('#name').textContent = cleanName(d.name);
  $('#qr').innerHTML = qr;
  $('#pin').innerHTML = [...d.pin].map((c) => `<span>${c}</span>`).join('');
  set('fiesta.ticket', `ticket.html?t=${encodeURIComponent(token)}`);
  const digits = [...document.querySelectorAll('#pin span')];

  $('#reveal').hidden = false;
  $('#dl').addEventListener('click', async () => {
    try { save(await ticketPng(d, qr), 'entrada-fiesta.png'); }
    catch { save(new Blob([qr], { type: 'image/svg+xml' }), 'entrada-fiesta-qr.svg'); }
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
