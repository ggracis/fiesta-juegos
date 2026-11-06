// Server-keyed rounds for quiz and pixel. Pure: used by the server and the static demo.
import { quizPoints, pixelPoints, pixelTotal, clampScore } from './scoring.js';

export const ROUND_GAMES = ['quiz', 'pixel'];
// game -> (correct: boolean, ms: number, params) => points. Games without a formula store 0 points.
export const ROUND_POINTS = { quiz: quizPoints, pixel: pixelPoints };
// Final score of a round game from its stored answers ({ points }) and the number of rounds it had.
// A correct answer always earns points (> 0), so points > 0 marks it correct.
export const roundsTotal = (game, answers, n) => game === 'pixel'
  ? pixelTotal(answers.map((x) => ({ points: x.points, correct: x.points > 0 })), n)
  : clampScore(answers.reduce((s, x) => s + x.points, 0));

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const shuffle = (arr, rng) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// quiz bank: { question, correct, wrong: [3] }; pixel bank: { file, label, group }.
export function buildRounds(game, bank, n, rng) {
  const labels = game === 'pixel' ? new Set(bank.map((r) => r.label)).size : 0;
  if (bank.length < (game === 'pixel' ? 4 : 1) || (game === 'pixel' && labels < 4)) throw new Error('not_enough_content');
  return shuffle(bank, rng).slice(0, n).map((r) => {
    if (game === 'quiz') {
      const options = shuffle([r.correct, ...r.wrong], rng);
      return { prompt: r.question, options, answer: options.indexOf(r.correct) };
    }
    const others = [...new Map(bank.filter((x) => x.label !== r.label).map((x) => [x.label, x])).values()];
    const pool = shuffle(others, rng);
    const wrong = [...pool.filter((x) => x.group === r.group), ...pool.filter((x) => x.group !== r.group)].slice(0, 3).map((x) => x.label);
    const options = shuffle([r.label, ...wrong], rng);
    return { prompt: '', image: r.file, options, answer: options.indexOf(r.label) };
  });
}

export const publicRounds = (rounds) => rounds.map(({ answer, ...r }) => r);
