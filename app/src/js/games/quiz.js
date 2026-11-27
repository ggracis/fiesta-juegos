import gsap from 'gsap';
import { rounds as fetchRounds, answer } from '../api.js';
import { RM, wait } from '../common.js';
import { withRetry } from '../retry.js';
import '../../css/quiz.css';

// Client side of the server-keyed rounds: the key never reaches the panel, so feedback waits for POST /answer.
const FEEDBACK_MS = 1200;
const ANSWER_BUDGET_MS = 10_000; // then the answer counts as 0 on screen and the game moves on
const LETTERS = 'ABCD';
const abortError = () => new DOMException('aborted', 'AbortError');

async function play(root, { attemptId, session, params, sfx, tap, idle, signal }) {
  const secs = Number(params.secondsPerQuestion) || 12;
  const t0 = performance.now();

  // Ends the game early: idle timeout keeps the score so far, the panel's abort rejects quietly.
  const end = new AbortController();
  let idleEnded = false;
  signal.addEventListener('abort', () => end.abort(), { once: true });
  const race = (p) => new Promise((res, rej) => {
    if (end.signal.aborted) return rej(abortError());
    end.signal.addEventListener('abort', () => rej(abortError()), { once: true });
    p.then(res, rej);
  });

  const { rounds } = await race(withRetry(() => fetchRounds(attemptId, session), { signal: end.signal }));

  // Own layer over the El Distinto markup; it stays under the result screen and goes when the panel leaves.
  root.querySelector('.qz')?.remove();
  const others = [...root.children];
  others.forEach((el) => { el.hidden = true; });
  root.insertAdjacentHTML('beforeend', `<div class="qz">
    <div class="qz-top"><span class="qz-n"></span><span class="qz-pts">Puntos <b>0</b></span></div>
    <div class="qz-timer"><div class="qz-track"><i></i></div><b class="qz-secs"></b></div>
    <p class="qz-q"></p>
    <div class="qz-opts">${[...LETTERS].map((l, i) => `<button type="button" data-i="${i}"><em>${l}</em><span></span></button>`).join('')}</div>
    <p class="qz-msg" aria-live="polite"></p>
  </div>`);
  const qz = root.lastElementChild;
  const el = (s) => qz.querySelector(s);
  const bar = el('.qz-track i'), secsEl = el('.qz-secs'), msg = el('.qz-msg'), ptsEl = el('.qz-pts b');
  const btns = [...qz.querySelectorAll('.qz-opts button')];
  signal.addEventListener('abort', () => { gsap.killTweensOf([bar, qz, ...btns]); qz.remove(); others.forEach((x) => { x.hidden = false; }); }, { once: true });

  let onPick = null;
  tap(el('.qz-opts'), (e) => { const b = e.target.closest('button'); if (b && onPick) onPick(+b.dataset.i); });
  idle.start(() => { idleEnded = true; end.abort(); });

  // Shows round i and resolves with the tapped option (null on timeout) and the ms it took.
  function ask(r, i) {
    el('.qz-n').innerHTML = `Pregunta <b>${i + 1}</b> de ${rounds.length}`;
    el('.qz-q').textContent = r.prompt;
    btns.forEach((b, k) => { b.className = ''; b.lastElementChild.textContent = r.options[k]; });
    msg.textContent = ' '; msg.className = 'qz-msg';
    bar.classList.remove('hurry'); secsEl.textContent = secs;
    if (!RM) gsap.fromTo([el('.qz-q'), ...btns], { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.05, clearProps: 'opacity,transform' }); // inline opacity would beat .off
    const start = performance.now();
    return new Promise((resolve) => {
      const tl = gsap.timeline({ onComplete: () => done(null) })
        .fromTo(bar, { scaleX: 1 }, { scaleX: 0, duration: secs, ease: RM ? `steps(${secs})` : 'none',
          onUpdate() { secsEl.textContent = Math.max(0, Math.ceil(secs * (1 - this.progress()))); } }, 0)
        .call(() => bar.classList.add('hurry'), [], Math.max(0, secs - 3));
      const kill = () => tl.kill();
      end.signal.addEventListener('abort', kill, { once: true });
      function done(choice) {
        tl.kill(); onPick = null;
        end.signal.removeEventListener('abort', kill);
        resolve({ choice, ms: choice === null ? secs * 1000 : performance.now() - start });
      }
      onPick = done;
    });
  }

  let score = 0;
  try {
    for (let i = 0; i < rounds.length; i++) {
      const { choice, ms } = await race(ask(rounds[i], i));
      if (choice !== null) btns[choice].classList.add('pick');
      let res = null, recorded = false;
      try { res = await race(withRetry(() => answer(attemptId, session, i, choice, Math.round(ms)), { signal: end.signal, budgetMs: ANSWER_BUDGET_MS })); }
      catch (e) {
        if (end.signal.aborted) throw e;
        recorded = e.code === 'already_answered'; // a lost response whose retry hit 409: the server has it, we don't know the points
      } // otherwise gave up: counts as 0 on screen
      btns.forEach((b, k) => b.classList.add(!res ? (k === choice ? 'pick' : 'off') : k === res.correctChoice ? 'ok' : k === choice ? 'bad' : 'off'));
      if (recorded) msg.textContent = 'Respuesta registrada';
      else if (!res) { msg.textContent = 'Sin conexión'; sfx.bad(); }
      else if (res.correct) {
        score += res.points; ptsEl.textContent = score;
        msg.textContent = `¡Correcto! +${res.points}`; msg.classList.add('good'); sfx.good();
        if (!RM) gsap.fromTo(btns[res.correctChoice], { scale: 1 }, { scale: 1.05, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.out', clearProps: 'transform' });
      } else {
        msg.textContent = choice === null ? 'Se acabó el tiempo' : 'Incorrecto'; msg.classList.add('bad'); sfx.bad();
      }
      await race(wait(FEEDBACK_MS));
    }
  } catch (e) {
    if (!idleEnded) throw e; // the panel left the game
  }
  onPick = null;
  // Display only: the server sums the stored answer points and ignores this score.
  return { score: Math.min(100, score), durationMs: Math.round(performance.now() - t0) };
}

const HAND = '<svg class="hand" viewBox="0 0 100 130" aria-hidden="true"><path d="M38 6a10 10 0 0 1 20 0v52l8-3c9-3 17 5 13 14l-12 40c-3 9-10 16-20 16H44c-10 0-18-6-24-14L6 88c-4-6 1-14 8-12l14 5V6a10 10 0 0 1 10 0z" fill="#fff" stroke="#2A0610" stroke-width="3"/></svg>';

// How-to illustration: sample question and 4 answers, the bar draining, a tap on the right one (+10), then fast vs slow points.
function art(el, setStep) {
  const opts = ['Venus', 'Mercurio', 'Marte', 'Tierra'];
  el.innerHTML = `<div class="qdemo"><div class="qd-track"><i></i></div><p class="qd-q">¿Qué planeta está más cerca del Sol?</p>
    <div class="qd-opts">${opts.map((o, i) => `<span><em>${LETTERS[i]}</em>${o}</span>`).join('')}</div>
    <div class="qd-pts"><b class="fast">Rápido +10</b><b class="slow">Lento +6</b></div>${HAND}<b class="qd-plus">+10</b></div>`;
  const q = (s) => el.querySelector(s), bar = q('.qd-track i'), hand = q('.hand'), plus = q('.qd-plus'), chips = [...el.querySelectorAll('.qd-pts b')];
  const [, right] = [...el.querySelectorAll('.qd-opts span')], rest = [...el.querySelectorAll('.qd-opts span')].filter((s) => s !== right);
  const hx = right.offsetLeft + 90, hy = right.offsetTop + 30; // fingertip lands on the right answer
  if (RM) { right.classList.add('ok'); gsap.set([bar], { scaleX: 0.6 }); setStep(2); return () => {}; }
  gsap.set(hand, { x: hx + 300, y: hy + 220, opacity: 0 });
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5 })
    .call(() => { right.classList.remove('ok'); setStep(0); }, [], 0)
    .set(bar, { scaleX: 1 }, 0).set(chips, { opacity: 0, y: 12 }, 0).set(plus, { opacity: 0 }, 0)
    .fromTo(q('.qd-q'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, 0)
    .fromTo(q('.qd-opts').children, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.12 }, 0.5)
    .to(bar, { scaleX: 0.78, duration: 2.2, ease: 'none' }, 0.5)
    .call(setStep, [1], 2.6)
    .to(hand, { opacity: 1, x: hx, y: hy, duration: 0.6, ease: 'power2.out' }, 2.6)
    .to(hand, { scale: 0.88, duration: 0.1, yoyo: true, repeat: 1 }, 3.3)
    .call(() => right.classList.add('ok'), [], 3.35)
    .to(rest, { opacity: 0.35, duration: 0.2 }, 3.35)
    .fromTo(plus, { opacity: 1, x: hx + 160, y: hy - 20 }, { opacity: 0, y: hy - 120, duration: 0.9, ease: 'power1.out' }, 3.4)
    .to(hand, { opacity: 0, duration: 0.3 }, 3.9)
    .call(setStep, [2], 4.4)
    .to(chips, { opacity: 1, y: 0, duration: 0.4, stagger: 0.35, ease: 'back.out(2)' }, 4.4)
    .to(rest, { opacity: 1, duration: 0.2 }, 7.2)
    .to({}, { duration: 0.1 }, 7.4);
  return () => tl.kill();
}

export default {
  id: 'quiz',
  howTo: { title: 'Así se juega', steps: ['Leé la pregunta', 'Tocá la respuesta', 'Rápido, más puntos'], art },
  play,
};
