import type { DatabaseSync } from 'node:sqlite';
import { dayEnd, dayOf } from './rules.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_diff_puzzles (
  day TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  word TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_diff_games (
  login TEXT NOT NULL REFERENCES players(login) ON UPDATE CASCADE ON DELETE CASCADE,
  day TEXT NOT NULL REFERENCES daily_diff_puzzles(day),
  guesses TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  solved INTEGER,
  PRIMARY KEY (login, day)
);
CREATE INDEX IF NOT EXISTS daily_diff_finished ON daily_diff_games(day, finished_at);
`;

export type Puzzle = { day: string; number: number; word: string };
export type DdGame = { login: string; day: string; guesses: string[]; startedAt: number; finishedAt: number | null; solved: boolean | null };
export type BoardRow = { rank: number; login: string; points: number | null; guesses: number | null; played: number; ms: number };
export type Period = 'today' | 'week' | 'month' | 'all';

const TOP = 20;
const DAY = 24 * 3600 * 1000;
const VISIBLE = `p.login <> 'ghost-' || p.github_id AND p.github_created_at <= ?`;

type GameRow = { login: string; day: string; guesses: string; started_at: number; finished_at: number | null; solved: number | null };
const toGame = (r: GameRow): DdGame => ({
  login: r.login,
  day: r.day,
  guesses: JSON.parse(r.guesses) as string[],
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  solved: r.solved === null ? null : r.solved === 1,
});

export function dailyDiffStore(db: DatabaseSync) {
  db.exec(SCHEMA);
  const q = {
    puzzle: db.prepare('SELECT day, number, word FROM daily_diff_puzzles WHERE day = ?'),
    lastUse: db.prepare('SELECT word, MAX(day) AS last FROM daily_diff_puzzles GROUP BY word'),
    nextNumber: db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM daily_diff_puzzles'),
    addPuzzle: db.prepare('INSERT INTO daily_diff_puzzles (day, number, word) VALUES (?, ?, ?)'),
    closeStale: db.prepare(
      `UPDATE daily_diff_games SET finished_at = (unixepoch(day) + 86400) * 1000, solved = 0
       WHERE finished_at IS NULL AND day < ?`,
    ),
    game: db.prepare('SELECT * FROM daily_diff_games WHERE login = ? AND day = ?'),
    addGame: db.prepare('INSERT OR IGNORE INTO daily_diff_games (login, day, started_at) VALUES (?, ?, ?)'),
    save: db.prepare(
      `UPDATE daily_diff_games SET guesses = ?, finished_at = ?, solved = ?
       WHERE login = ? AND day = ? AND finished_at IS NULL AND json_array_length(guesses) = ?`,
    ),
    today: db.prepare(
      `SELECT g.login, g.solved, json_array_length(g.guesses) AS n, g.finished_at - g.started_at AS ms
       FROM daily_diff_games g JOIN players p ON p.login = g.login
       WHERE g.day = ? AND g.finished_at IS NOT NULL AND ${VISIBLE}
       ORDER BY g.solved DESC, n ASC, ms ASC, g.login ASC`,
    ),
    period: db.prepare(
      `SELECT g.login, SUM(CASE g.solved WHEN 1 THEN 7 - json_array_length(g.guesses) ELSE 0 END) AS points,
              COUNT(*) AS played, SUM(g.finished_at - g.started_at) AS ms
       FROM daily_diff_games g JOIN players p ON p.login = g.login
       WHERE g.day >= ? AND g.day <= ? AND g.finished_at IS NOT NULL AND ${VISIBLE}
       GROUP BY g.login ORDER BY points DESC, ms ASC, g.login ASC`,
    ),
    mine: db.prepare(
      'SELECT day, solved, json_array_length(guesses) AS n FROM daily_diff_games WHERE login = ? AND finished_at IS NOT NULL ORDER BY day',
    ),
  };

  return {
    ensurePuzzle(day: string, answers: string[], rand: (n: number) => number): Puzzle {
      const have = q.puzzle.get(day) as Puzzle | undefined;
      if (have) return { ...have };
      db.exec('BEGIN IMMEDIATE');
      try {
        let p = q.puzzle.get(day) as Puzzle | undefined;
        if (!p) {
          const last = new Map((q.lastUse.all() as { word: string; last: string }[]).map((r) => [r.word, r.last]));
          const fresh = answers.filter((w) => !last.has(w));
          // ponytail: once every answer has had a day, the least recently used comes back; shuffle the oldest few if repeats feel predictable
          const word = fresh.length ? fresh[rand(fresh.length)]! : [...answers].sort((a, b) => last.get(a)!.localeCompare(last.get(b)!))[0]!;
          p = { day, number: (q.nextNumber.get() as { n: number }).n, word };
          q.addPuzzle.run(p.day, p.number, p.word);
        }
        db.exec('COMMIT');
        return { ...p };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    closeStale(today: string) {
      q.closeStale.run(today);
    },

    getGame(login: string, day: string): DdGame | null {
      const r = q.game.get(login, day) as GameRow | undefined;
      return r ? toGame(r) : null;
    },

    startGame(login: string, day: string, now: number): DdGame {
      q.addGame.run(login, day, now);
      return toGame(q.game.get(login, day) as GameRow);
    },

    saveGuesses(login: string, day: string, guesses: string[], end: { at: number; solved: boolean } | null): boolean {
      const solved = end === null ? null : end.solved ? 1 : 0;
      const r = q.save.run(JSON.stringify(guesses), end?.at ?? null, solved, login, day, guesses.length - 1);
      return Number(r.changes) > 0;
    },

    board(period: Period, today: string, from: string, createdBefore: number, login: string) {
      // ponytail: ranks every finisher in the window then slices; fine to tens of thousands of players
      const ranked: BoardRow[] =
        period === 'today'
          ? (q.today.all(today, createdBefore) as { login: string; solved: number; n: number; ms: number }[]).map((r, i) => ({
              rank: i + 1, login: r.login, points: null, guesses: r.solved === 1 ? r.n : null, played: 1, ms: r.ms,
            }))
          : (q.period.all(from, today, createdBefore) as { login: string; points: number; played: number; ms: number }[]).map((r, i) => ({
              rank: i + 1, login: r.login, points: r.points, guesses: null, played: r.played, ms: r.ms,
            }));
      const mine = ranked.find((r) => r.login === login);
      return { rows: ranked.slice(0, TOP), you: mine && mine.rank > TOP ? mine : null };
    },

    stats(login: string, today: string) {
      const games = q.mine.all(login) as { day: string; solved: number; n: number }[];
      const distribution = [0, 0, 0, 0, 0, 0];
      let won = 0;
      let run = 0;
      let bestStreak = 0;
      let prev: string | null = null;
      for (const g of games) {
        const follows = prev !== null && Date.parse(`${g.day}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`) === DAY;
        if (g.solved === 1) {
          won++;
          distribution[g.n - 1]!++;
          run = follows && run > 0 ? run + 1 : 1;
        } else run = 0;
        bestStreak = Math.max(bestStreak, run);
        prev = g.day;
      }
      const yesterday = dayOf(dayEnd(today) - 2 * DAY);
      const streak = prev === today || prev === yesterday ? run : 0;
      return { played: games.length, won, streak, bestStreak, distribution };
    },
  };
}
