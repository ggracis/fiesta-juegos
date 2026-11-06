import type { DatabaseSync } from 'node:sqlite';
import { clampScore, MIN_TOTAL_MS, MEMO_MIN_MS } from '../src/shared/scoring.js';
import { ROUND_GAMES, roundsTotal } from '../src/shared/rounds.js';
import type { State } from './state.ts';

// The one place an attempt gets finished: used by POST /api/attempts/:id/result and by panel sync.
// Idempotent: a finished attempt returns its stored outcome (replay) and changes nothing.
export function makeResults(db: DatabaseSync, state: State) {
  return (id: string, score: number, durationMs: number, checkElapsed = true) => {
    const a = db.prepare('SELECT guest_id, game, started_at, finished_at, score, prize_won, no_prize, content FROM attempt WHERE id = ?').get(id) as any;
    if (!a) return { code: 404, error: 'unknown_attempt' };
    if (a.finished_at) return { score: a.score, replay: true, prizeWon: !!a.prize_won };
    const now = Date.now();
    // offline attempts are synced long after they started, and their startedAt is client-claimed: only durationMs is checked
    const minMs = a.game === 'memo' ? MEMO_MIN_MS : MIN_TOTAL_MS;
    if (durationMs < minMs || (checkElapsed && now - a.started_at < minMs)) return { code: 400, error: 'implausible_duration' };
    // round games: the score is the sum of server-computed answer points, never the client's
    const final = ROUND_GAMES.includes(a.game)
      ? roundsTotal(a.game, db.prepare('SELECT points FROM answer WHERE attempt_id = ?').all(id) as { points: number }[], a.content ? JSON.parse(a.content).length : 0)
      : clampScore(score);
    const prizeWon = state.tx(() => {
      let won = false;
      db.prepare('UPDATE attempt SET finished_at = ?, score = ?, duration_ms = ? WHERE id = ? AND finished_at IS NULL')
        .run(now, final, Math.round(durationMs), id);
      if (!a.no_prize && final >= (state.gameConfig(a.game)?.threshold ?? Infinity)) {
        // one statement: guest has no prize yet AND stock left, so stock can't go negative
        won = db.prepare(
          'UPDATE registration SET prize_won_at = ? WHERE guest_id = ? AND prize_won_at IS NULL AND (SELECT COUNT(*) FROM registration WHERE prize_won_at IS NOT NULL) < ?'
        ).run(now, a.guest_id, state.settings().prizeStock).changes === 1;
        if (won) db.prepare('UPDATE attempt SET prize_won = 1 WHERE id = ?').run(id);
      }
      return won;
    });
    return { score: final, replay: false, prizeWon };
  };
}
