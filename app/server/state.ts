import type { DatabaseSync } from 'node:sqlite';
import { gameById } from '../src/shared/games.js';

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
  });
  const fromRow = (id: string, row?: GameRow) => {
    const g = gameById(id);
    if (!g) return undefined;
    return {
      id, name: g.name as string, ready: !!g.ready,
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
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return { tx, getSetting, setSetting, settings, gameConfig, allGames, checkinView };
}
export type State = ReturnType<typeof makeState>;
