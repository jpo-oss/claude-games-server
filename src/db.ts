import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { LeaderboardReply } from './protocol.ts';

const DAY = 24 * 3600 * 1000;
const SESSION_IDLE = 30 * DAY;
const MIN_ACCOUNT_AGE = 30 * DAY;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  login TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  github_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL REFERENCES players(login) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS marathon_games (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL REFERENCES players(login) ON UPDATE CASCADE ON DELETE CASCADE,
  seed INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  score INTEGER,
  lines INTEGER,
  level INTEGER
);
CREATE TABLE IF NOT EXISTS battles (
  room_id TEXT PRIMARY KEY,
  player_a TEXT NOT NULL REFERENCES players(login) ON UPDATE CASCADE,
  player_b TEXT NOT NULL REFERENCES players(login) ON UPDATE CASCADE,
  seed INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  winner TEXT REFERENCES players(login) ON UPDATE CASCADE,
  counted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS marathon_best ON marathon_games(login, score);
CREATE INDEX IF NOT EXISTS battles_counted ON battles(winner, counted);
`;

export type MarathonGame = {
  id: string;
  login: string;
  seed: number;
  startedAt: number;
  finishedAt: number | null;
  score: number | null;
  lines: number | null;
  level: number | null;
};

export type Db = ReturnType<typeof openDb>;

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const token = (bytes: number) => randomBytes(bytes).toString('base64url');

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const q = {
    freeLogin: db.prepare("UPDATE players SET login = login || '#' || github_id WHERE login = ? AND github_id != ?"),
    upsert: db.prepare(
      `INSERT INTO players (login, github_id, github_created_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, github_created_at = excluded.github_created_at`,
    ),
    addSession: db.prepare('INSERT INTO sessions (token_hash, login, created_at, last_used_at) VALUES (?, ?, ?, ?)'),
    getSession: db.prepare('SELECT login, last_used_at FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    addGame: db.prepare('INSERT INTO marathon_games (id, login, seed, started_at) VALUES (?, ?, ?, ?)'),
    getGame: db.prepare(
      `SELECT id, login, seed, started_at AS startedAt, finished_at AS finishedAt, score, lines, level
       FROM marathon_games WHERE id = ?`,
    ),
    endGame: db.prepare('UPDATE marathon_games SET finished_at = ?, score = ?, lines = ?, level = ? WHERE id = ?'),
    best: db.prepare(
      `SELECT login, score, lines, level, at FROM (
         SELECT g.login, g.score, g.lines, g.level, g.finished_at AS at,
                ROW_NUMBER() OVER (PARTITION BY g.login ORDER BY g.score DESC, g.finished_at ASC) AS rn
         FROM marathon_games g JOIN players p ON p.login = g.login
         WHERE g.score IS NOT NULL AND g.finished_at IS NOT NULL AND p.github_created_at <= ?
       ) WHERE rn = 1 ORDER BY score DESC, at ASC LIMIT 5`,
    ),
    wins: db.prepare(
      `SELECT b.winner AS login, COUNT(*) AS wins
       FROM battles b JOIN players p ON p.login = b.winner
       WHERE b.counted = 1 AND p.github_created_at <= ?
       GROUP BY b.winner ORDER BY wins DESC, login ASC LIMIT 5`,
    ),
    addBattle: db.prepare('INSERT INTO battles (room_id, player_a, player_b, seed, started_at) VALUES (?, ?, ?, ?, ?)'),
    endBattle: db.prepare('UPDATE battles SET ended_at = ?, winner = ?, counted = ? WHERE room_id = ?'),
    pairToday: db.prepare(
      `SELECT 1 FROM battles WHERE counted = 1 AND ended_at >= ?
       AND ((player_a = ? AND player_b = ?) OR (player_a = ? AND player_b = ?)) LIMIT 1`,
    ),
  };

  return {
    close() {
      db.close();
    },

    upsertPlayer(p: { login: string; githubId: number; githubCreatedAt: number }, now: number) {
      // a login freed by a rename we haven't seen yet may still sit on another account's row
      q.freeLogin.run(p.login, p.githubId);
      q.upsert.run(p.login, p.githubId, p.githubCreatedAt, now);
    },

    createSession(login: string, now: number): string {
      const key = token(32);
      q.addSession.run(hash(key), login, now, now);
      return key;
    },

    findSession(key: string, now: number): string | null {
      const h = hash(key);
      const row = q.getSession.get(h) as { login: string; last_used_at: number } | undefined;
      if (!row) return null;
      if (now - row.last_used_at > SESSION_IDLE) {
        q.delSession.run(h);
        return null;
      }
      q.touchSession.run(now, h);
      return row.login;
    },

    deleteSession(key: string) {
      q.delSession.run(hash(key));
    },

    startMarathon(login: string, seed: number, now: number): string {
      const id = token(16);
      q.addGame.run(id, login, seed, now);
      return id;
    },

    getMarathon(id: string): MarathonGame | null {
      const row = q.getGame.get(id) as MarathonGame | undefined;
      return row ? { ...row } : null;
    },

    finishMarathon(id: string, result: { score: number; lines: number; level: number } | null, now: number) {
      q.endGame.run(now, result?.score ?? null, result?.lines ?? null, result?.level ?? null, id);
    },

    leaderboard(now: number): LeaderboardReply {
      const cutoff = now - MIN_ACCOUNT_AGE;
      return {
        marathon: q.best.all(cutoff).map((r) => ({ ...r })) as LeaderboardReply['marathon'],
        wins: q.wins.all(cutoff).map((r) => ({ ...r })) as LeaderboardReply['wins'],
      };
    },

    recordBattle(roomId: string, a: string, b: string, seed: number, now: number) {
      q.addBattle.run(roomId, a, b, seed, now);
    },

    finishBattle(roomId: string, winner: string | null, counted: boolean, now: number) {
      q.endBattle.run(now, winner, counted ? 1 : 0, roomId);
    },

    countedToday(a: string, b: string, now: number): boolean {
      const dayStart = now - (now % DAY);
      return q.pairToday.get(dayStart, a, b, b, a) !== undefined;
    },
  };
}
