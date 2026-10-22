import { isDemo } from './api.js';

export const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const $ = (s, r = document) => r.querySelector(s);

// One sprite per page; characters are <use> refs so thousands of nodes stay cheap.
// Colour comes from --h (hue) and the eye offset from --ex, both inherited into the <use> tree.
const BODY = 'hsl(var(--h) 85% 56%)';
const SHADE = 'hsl(var(--h) 80% 38%)';
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0" aria-hidden="true"><defs>
<symbol id="m-round" viewBox="0 0 100 100"><ellipse cx="50" cy="60" rx="38" ry="34" fill="${BODY}"/><ellipse cx="50" cy="81" rx="26" ry="10" fill="${SHADE}" opacity=".4"/><ellipse cx="34" cy="38" rx="11" ry="6" fill="#fff" opacity=".6" transform="rotate(-25 34 38)"/></symbol>
<symbol id="m-tall" viewBox="0 0 100 100"><ellipse cx="50" cy="56" rx="31" ry="42" fill="${BODY}"/><ellipse cx="50" cy="86" rx="22" ry="9" fill="${SHADE}" opacity=".4"/><ellipse cx="38" cy="30" rx="9" ry="6" fill="#fff" opacity=".6" transform="rotate(-25 38 30)"/></symbol>
<symbol id="m-box" viewBox="0 0 100 100"><rect x="13" y="28" width="74" height="64" rx="28" fill="${BODY}"/><rect x="22" y="78" width="56" height="10" rx="5" fill="${SHADE}" opacity=".4"/><ellipse cx="29" cy="42" rx="10" ry="5.5" fill="#fff" opacity=".6" transform="rotate(-25 29 42)"/></symbol>
<symbol id="face" viewBox="0 0 100 100"><circle cx="37" cy="54" r="10" fill="#fff"/><circle cx="63" cy="54" r="10" fill="#fff"/>
<circle cx="37" cy="55" r="5" fill="#2B0B12" style="transform:translateX(calc(var(--ex,0)*1px))"/><circle cx="63" cy="55" r="5" fill="#2B0B12" style="transform:translateX(calc(var(--ex,0)*1px))"/>
<circle cx="37" cy="54" r="10.5" fill="${BODY}" style="transform-origin:37px 43.5px;transform:scaleY(var(--lidL,0))"/><circle cx="63" cy="54" r="10.5" fill="${BODY}" style="transform-origin:63px 43.5px;transform:scaleY(var(--lidR,0))"/>
<path d="M42 72 Q50 79 58 72" stroke="#2B0B12" stroke-width="3.5" fill="none" stroke-linecap="round"/></symbol>
<symbol id="acc-hat" viewBox="0 0 100 100"><path d="M32 30 L50 3 L68 30 Z" fill="#FFC14D"/><circle cx="50" cy="5" r="5" fill="#fff"/></symbol>
<symbol id="acc-bow" viewBox="0 0 100 100"><path d="M50 26 L28 12 L28 40 Z M50 26 L72 12 L72 40 Z" fill="hsl(var(--h) 70% 28%)"/><circle cx="50" cy="26" r="5" fill="#fff"/></symbol>
<symbol id="acc-antenna" viewBox="0 0 100 100"><path d="M50 28 V10" stroke="hsl(var(--h) 70% 28%)" stroke-width="4"/><circle cx="50" cy="8" r="6" fill="#FFC14D"/></symbol>
<symbol id="acc-spot" viewBox="0 0 100 100"><path d="M74 66 l2.5 5.5 6 .7-4.4 4 1.3 5.9-5.4-3-5.4 3 1.3-5.9-4.4-4 6-.7z" fill="#fff"/></symbol>
</defs></svg>`;

export function injectSprite() { document.body.insertAdjacentHTML('afterbegin', SPRITE); }

export function mascot({ h = 350, shape = 'round', ex = 0, acc = 'none', tilt = 0, cue = false, cls = '' } = {}) {
  const t = tilt ? `transform:rotate(${tilt}deg)` : '';
  return `<svg class="mz ${cls}" viewBox="0 0 100 100" style="--h:${h};--ex:${ex};${t}" aria-hidden="true"><use href="#m-${shape}"/><use href="#face"/>${acc !== 'none' ? `<use href="#acc-${acc}"/>` : ''}${cue ? '<use href="#acc-spot"/>' : ''}</svg>`;
}

const WARM = [350, 8, 22, 38, 330];
const SHAPES = ['round', 'tall', 'box'];
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
export const cleanName = (n) => n.replace(/\s*\(demo\)$/, '');
export const firstName = (n) => cleanName(n).split(' ')[0];

// Mascot with the guest's initial on its belly.
export function avatar(name) {
  const k = hash(name);
  return `<span class="av">${mascot({ h: WARM[k % 5], shape: SHAPES[k % 3] })}<b>${cleanName(name)[0].toUpperCase()}</b></span>`;
}

export function demoBadge() {
  if (isDemo) document.body.insertAdjacentHTML('beforeend', '<div class="demo-badge">Modo demo</div>');
}

export const vibrate = (ms) => { try { navigator.vibrate?.(ms); } catch {} };
