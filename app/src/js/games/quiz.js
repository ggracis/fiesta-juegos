import gsap from 'gsap';
import { rounds as fetchRounds, answer } from '../api.js';
import { RM, wait } from '../common.js';
import '../../css/quiz.css';

// Client side of the server-keyed rounds: the key never reaches the panel, so feedback waits for POST /answer.
const FEEDBACK_MS = 1200;
const LETTERS = 'ABCD';
const abortError = () => new DOMException('aborted', 'AbortError');

// ponytail: same 1/2/4 s backoff as finishWithRetry in play.js; only network errors retry.
async function withRetry(fn, signal) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (e.code !== 'network' || i === 3 || signal.aborted) throw e; await wait(1000 * 2 ** i); }
  }
}

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

  const { rounds } = await race(withRetry(() => fetchRounds(attemptId, session), end.signal));

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
      let res = null;
      try { res = await race(withRetry(() => answer(attemptId, session, i, choice, Math.round(ms)), end.signal)); }
      catch (e) { if (end.signal.aborted) throw e; } // gave up: counts as 0
      btns.forEach((b, k) => b.classList.add(!res ? (k === choice ? 'pick' : 'off') : k === res.correctChoice ? 'ok' : k === choice ? 'bad' : 'off'));
      if (!res) { msg.textContent = 'Sin conexión'; sfx.bad(); }
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

export default {
  id: 'quiz',
  howTo: { title: 'Así se juega', steps: ['Lee la pregunta', 'Toca la respuesta', 'Más rápido, más puntos'] },
  play,
};
