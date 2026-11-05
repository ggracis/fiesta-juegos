// Game catalog. `ready: false` games are configurable but never offered on the panels until implemented.
export const GAMES = [
  { id: 'memo', name: 'Memo Test', ready: false, defaults: { threshold: 70, maxAttempts: 1, sort: 1, params: {} } },
  { id: 'quiz', name: 'Quiz', ready: false, defaults: { threshold: 70, maxAttempts: 1, sort: 2, params: {} } },
  { id: 'pixel', name: 'Pixel Revelado', ready: false, defaults: { threshold: 70, maxAttempts: 1, sort: 3, params: {} } },
  { id: 'distinto', name: 'El Distinto', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 4, params: {} } },
];
export const gameById = (id) => GAMES.find((g) => g.id === id);
