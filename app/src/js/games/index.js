// src/js/games/<id>.js — default export:
// { id, howTo: { title, steps: [<=3 short lines, neutral Spanish], art? }, play(root, ctx) -> Promise<{ score, durationMs }> }
// play() renders inside `root` (the game screen element) and resolves when the game ends.
// ctx: { attemptId, session, params, sfx, tap, rng?, idle, signal }  — signal: AbortSignal aborted when the panel leaves the game (toAttract / pause etc.); the module must stop timers and resolve or reject quietly.
// ctx.idle: { start(onTimeout), bump(), stop() } — "¿Sigues ahí?" notice after params.idleSeconds (20) without a touch,
//   then onTimeout after a further params.idleWarnSeconds (5); the module ends the game with the score so far.
// howTo.art (optional): (el, setStep) -> stop() — renders the how-to illustration into `el`; setStep(i) highlights step i.
import distinto from './distinto.js';
import memo from './memo.js';
import pixel from './pixel.js';

export const GAME_MODULES = { distinto, memo, pixel };
