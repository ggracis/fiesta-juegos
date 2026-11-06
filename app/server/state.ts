import type { DatabaseSync } from 'node:sqlite';
import { gameById } from '../src/shared/games.js';
import { DEFAULT_STAGE } from '../src/shared/stage.js';

type GameRow = { game: string; enabled: number; sort: number; threshold: number; max_attempts: number; params: string };

// Settings, game config and check-in views, shared by the public and admin routes.
export function makeState(db: DatabaseSync) {
  const getSetting = (key: string) => {
    const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  };
  const setSetting = (key: string, value: unknown) => {
    db.prepare('INSERT INTO setting(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  };
  const settings = () => ({
    paused: !!getSetting('paused'),
    transition: !!getSetting('transition'),
    transitionText: String(getSetting('transitionText') ?? ''),
    prizeStock: Number(getSetting('prizeStock')) || 0,
    raffleShowSeconds: Number(getSetting('raffleShowSeconds')) || 15,
    raffleMode: !!getSetting('raffleMode'),
  });
  // Round games are only ready with enough content to build rounds (same minimum as buildRounds),
  // so an empty bank never shows the game on a panel or burns an attempt.
  const hasContent = (id: string) =>
    id === 'quiz' ? (db.prepare('SELECT COUNT(*) AS n FROM quiz_question').get() as { n: number }).n >= 1
    : id === 'pixel' ? (db.prepare('SELECT COUNT(DISTINCT label) AS n FROM pixel_image').get() as { n: number }).n >= 4
    : true;
  const fromRow = (id: string, row?: GameRow) => {
    const g = gameById(id);
    if (!g) return undefined;
    return {
      id, name: g.name as string, ready: !!g.ready && hasContent(id),
      enabled: row ? !!row.enabled : !!g.ready,
      sort: row?.sort ?? g.defaults.sort,
      threshold: row?.threshold ?? g.defaults.threshold,
      maxAttempts: row?.max_attempts ?? g.defaults.maxAttempts,
      params: { ...g.defaults.params, ...JSON.parse(row?.params ?? '{}') } as Record<string, unknown>,
    };
  };
  const gameConfig = (id: string) =>
    fromRow(id, db.prepare('SELECT * FROM game_config WHERE game = ?').get(id) as GameRow | undefined);
  const allGames = () =>
    (db.prepare('SELECT * FROM game_config ORDER BY sort, game').all() as GameRow[])
      .map((r) => fromRow(r.game, r)).filter((g) => !!g);
  const checkinView = (token: string) => db.prepare(
    `SELECT g.name, r.checked_in_at AS checkedInAt, r.prize_won_at AS prizeWonAt, r.prize_delivered_at AS prizeDeliveredAt
     FROM registration r JOIN guest g ON g.id = r.guest_id WHERE r.checkin_token = ?`
  ).get(token) as { name: string; checkedInAt: number | null; prizeWonAt: number | null; prizeDeliveredAt: number | null } | undefined;
  const stage = () => ({ ...DEFAULT_STAGE, ...getSetting('stage') }) as typeof DEFAULT_STAGE;
  // Public stage payload for /api/live: only what the LED wall shows (names, roles, prize), never guest data beyond the winner's name.
  const stageView = () => {
    const s = stage();
    const w = s.winner ? db.prepare('SELECT r.id, g.name, r.prize, r.drawn_at FROM raffle r JOIN guest g ON g.id = r.guest_id WHERE r.id = ?').get(s.winner) as
      { id: number; name: string; prize: string | null; drawn_at: number } | undefined : undefined;
    return {
      scene: s.scene, at: s.at, cueAt: s.cueAt, video: s.video,
      speaker: s.speakers[s.speaker] ?? null, speakerIndex: s.speaker, speakerCount: s.speakers.length,
      winner: w ? { id: w.id, name: w.name, prize: w.prize ?? '', drawnAt: w.drawn_at } : null,
    };
  };
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return { tx, getSetting, setSetting, settings, stage, stageView, gameConfig, allGames, checkinView };
}
export type State = ReturnType<typeof makeState>;
