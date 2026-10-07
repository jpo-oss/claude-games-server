import { randomInt } from 'node:crypto';
import { MIN_ACCOUNT_AGE } from '../db.ts';
import type { Db } from '../db.ts';
import type { Route } from '../http.ts';
import type { DdGame, Puzzle } from '../daily-diff/store.ts';
import type { Words } from '../daily-diff/words.ts';
import { MAX_GUESSES, WORD, dayEnd, dayOf, marks, monthStart, weekStart } from '../daily-diff/rules.ts';

type Deps = { db: Db; words: Words | null; random?: (n: number) => number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const OFF = { status: 503, body: { error: 'daily diff is not set up on this server' } };
const PERIODS = new Set(['today', 'week', 'month', 'all']);

export function dailyDiffRoutes(deps: Deps): Route[] {
  const { words } = deps;
  const dd = deps.db.dailyDiff;
  const rand = deps.random ?? ((n: number) => randomInt(0, n));

  const today = (now: number): Puzzle => {
    const day = dayOf(now);
    dd.closeStale(day);
    return dd.ensurePuzzle(day, words!.answers, rand);
  };
  const view = (p: Puzzle, g: DdGame) => {
    const state = g.finishedAt === null ? 'playing' : g.solved ? 'won' : 'lost';
    return {
      number: p.number,
      day: p.day,
      endsAt: dayEnd(p.day),
      guesses: g.guesses.map((word) => ({ word, marks: marks(word, p.word) })),
      state,
      answer: state === 'playing' ? null : p.word,
    };
  };
  const route = (method: string, path: string, handler: Route['handler'], extra: Partial<Route> = {}): Route => ({
    method,
    path,
    auth: true,
    game: 'daily-diff',
    ...extra,
    handler: async (ctx) => (words ? handler(ctx) : OFF),
  });

  return [
    route('GET', '/v1/daily-diff/today', async (ctx) => {
      const p = today(ctx.now);
      return { status: 200, body: view(p, dd.startGame(ctx.login!, p.day, ctx.now)) };
    }),
    route(
      'POST',
      '/v1/daily-diff/guess',
      async (ctx) => {
        const b = ctx.body;
        if (!isRecord(b) || !Number.isInteger(b.number) || typeof b.word !== 'string') return { status: 400, body: { error: 'bad request' } };
        const p = today(ctx.now);
        if (b.number !== p.number) return { status: 409, body: { error: 'new puzzle' } };
        const g = dd.getGame(ctx.login!, p.day);
        if (!g) return { status: 409, body: { error: 'open the puzzle first' } };
        if (g.finishedAt !== null) return { status: 409, body: { error: 'already finished' } };
        if (!WORD.test(b.word) || !words!.isWord(b.word)) return { status: 422, body: { error: 'not in word list' } };
        const guesses = [...g.guesses, b.word];
        const solved = b.word === p.word;
        const end = solved || guesses.length >= MAX_GUESSES ? { at: ctx.now, solved } : null;
        if (!dd.saveGuesses(ctx.login!, p.day, guesses, end)) return { status: 409, body: { error: 'guess already taken, reload' } };
        return { status: 200, body: view(p, dd.getGame(ctx.login!, p.day)!) };
      },
      { limit: { ratePerSec: 2, burst: 10, by: 'ip' } },
    ),
    route('GET', '/v1/daily-diff/leaderboard/:period', async (ctx) => {
      const period = ctx.params.period!;
      if (!PERIODS.has(period)) return { status: 404, body: { error: 'not found' } };
      const day = dayOf(ctx.now);
      dd.closeStale(day);
      const from = period === 'today' ? day : period === 'week' ? weekStart(day) : period === 'month' ? monthStart(day) : '0000-01-01';
      const board = dd.board(period as 'today' | 'week' | 'month' | 'all', day, from, ctx.now - MIN_ACCOUNT_AGE, ctx.login!);
      return { status: 200, body: { period, ...board } };
    }),
    route('GET', '/v1/daily-diff/stats', async (ctx) => {
      const day = dayOf(ctx.now);
      dd.closeStale(day);
      return { status: 200, body: dd.stats(ctx.login!, day) };
    }),
  ];
}
