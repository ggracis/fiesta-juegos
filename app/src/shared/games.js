// Game catalog. `ready: false` games are configurable but never offered on the panels until implemented.
const idle = { idleSeconds: 20, idleWarnSeconds: 5 };
export const GAMES = [
  { id: 'memo', name: 'Memo Test', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 1, params: { ...idle, timeLimitS: 90, freeSeconds: 20, wrongPenalty: 2, finishFloor: 40 } } },
  { id: 'quiz', name: 'Quiz Relámpago', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 2, params: { ...idle, questions: 10, secondsPerQuestion: 12 } } },
  { id: 'pixel', name: 'Pixel Revelado', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 3, params: { ...idle, images: 8, revealSeconds: 10 } } },
  { id: 'distinto', name: 'El Distinto', ready: true, defaults: { threshold: 70, maxAttempts: 1, sort: 4, params: { ...idle } } },
];
export const gameById = (id) => GAMES.find((g) => g.id === id);

// Admin "Juegos" tab: label, one-line help, unit and input bounds for every setting above.
// A new game declares its own param keys here (a test checks that none is missing).
export const PARAM_INFO = {
  sort: { label: 'Orden en el menú', help: 'Posición del juego en el menú de las pantallas (menor va primero).', min: 0, max: 99 },
  threshold: { label: 'Puntaje mínimo para ganar premio', help: 'Quien llega a este puntaje (de 0 a 100) gana premio, mientras haya stock.', unit: 'pts', min: 0, max: 100 },
  maxAttempts: { label: 'Intentos por invitado', help: 'Cuántas veces puede jugar cada invitado a este juego.', min: 1, max: 10 },
  idleSeconds: { label: 'Inactividad antes del aviso', help: 'Segundos sin tocar la pantalla hasta que aparece «¿Sigues ahí?».', unit: 's', min: 5, max: 120 },
  idleWarnSeconds: { label: 'Duración del aviso', help: 'Segundos que dura el aviso; si nadie toca, la partida termina con el puntaje que lleve.', unit: 's', min: 2, max: 30 },
  timeLimitS: { label: 'Tiempo máximo de la partida', help: 'Al agotarse, la partida termina y suma 5 puntos por par encontrado.', unit: 's', min: 30, max: 300 },
  freeSeconds: { label: 'Segundos sin descuento', help: 'Tiempo antes de que cada segundo extra empiece a restar 1 punto.', unit: 's', min: 0, max: 120 },
  wrongPenalty: { label: 'Penalidad por par equivocado', help: 'Puntos que resta cada par que no coincide.', unit: 'pts', min: 0, max: 20 },
  finishFloor: { label: 'Puntaje mínimo al completar', help: 'Puntaje garantizado a quien completa el tablero, aunque haya tardado.', unit: 'pts', min: 0, max: 100 },
  questions: { label: 'Preguntas por partida', help: 'Cantidad de rondas por partida (sale del banco cargado en Contenido).', min: 1, max: 20 },
  secondsPerQuestion: { label: 'Tiempo por pregunta', help: 'Segundos para responder; responder antes suma más puntos.', unit: 's', min: 3, max: 60 },
  images: { label: 'Imágenes por partida', help: 'Cantidad de rondas por partida (sale de las imágenes cargadas en Contenido).', min: 1, max: 12 },
  revealSeconds: { label: 'Tiempo por imagen', help: 'Segundos que tarda la imagen en verse nítida; adivinar antes suma más puntos.', unit: 's', min: 3, max: 30 },
};
