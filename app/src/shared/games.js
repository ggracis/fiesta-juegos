// Game catalog. `ready: false` games are configurable but never offered on the panels until implemented.
const idle = { idleSeconds: 20, idleWarnSeconds: 5 };
export const GAMES = [
  { id: 'memo', name: 'Memo Test', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 1, params: { ...idle, timeLimitS: 90, freeSeconds: 20, wrongPenalty: 2, finishFloor: 40 } } },
  { id: 'quiz', name: 'Quiz', ready: false, defaults: { threshold: 70, maxAttempts: 1, sort: 2, params: { ...idle, questions: 10, secondsPerQuestion: 12 } } },
  { id: 'pixel', name: 'Pixel Revelado', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 3, params: { ...idle, images: 8, revealSeconds: 10 } } },
  { id: 'distinto', name: 'El Distinto', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 4, params: { ...idle } } },
];
export const gameById = (id) => GAMES.find((g) => g.id === id);
