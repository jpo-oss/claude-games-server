import { randomInt } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Route } from '../http.ts';
import type { ReplayResult } from '../replay.ts';
import { parseScoreBody } from '../protocol.ts';
import type { GameLog, MarathonStartReply } from '../protocol.ts';

const STEP_MS = 16;
const SLACK_MS = 5_000;
const MAX_OPEN = 5;
const OPEN_WINDOW = 2 * 3600 * 1000;
const RETRYABLE = new Set(['busy', 'timeout', 'closed', 'replay failed']);

type Deps = {
  db: Db;
  replayer: { run(job: { seed: number; mode: 'marathon'; log: GameLog }): Promise<ReplayResult> };
  random?: () => number;
};

export function marathonRoutes(deps: Deps): Route[] {
  const { db, replayer } = deps;
  const seed = deps.random ?? (() => randomInt(0, 2 ** 32));
  return [
    {
      method: 'GET',
      path: '/v1/leaderboard',
      auth: true,
      handler: async (ctx) => ({ status: 200, body: db.leaderboard(ctx.now) }),
    },
    {
      method: 'POST',
      path: '/v1/marathon',
      auth: true,
      handler: async (ctx) => {
        if (db.openMarathons(ctx.login!, ctx.now - OPEN_WINDOW) >= MAX_OPEN) {
          return { status: 429, body: { error: 'too many open games' } };
        }
        const s = seed();
        const body: MarathonStartReply = { gameId: db.startMarathon(ctx.login!, s, ctx.now), seed: s };
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/scores',
      auth: true,
      bodyLimit: 262_144,
      handler: async (ctx) => {
        const parsed = parseScoreBody(ctx.body);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
        const { gameId, log } = parsed.value;
        const game = db.getMarathon(gameId);
        if (!game || game.login !== ctx.login) return { status: 404, body: { error: 'no such game' } };
        if (game.finishedAt !== null) return { status: 409, body: { error: 'already submitted' } };

        const reject = (error: string) =>
          db.finishMarathon(gameId, null, ctx.now)
            ? { status: 422, body: { error } }
            : { status: 409, body: { error: 'already submitted' } };

        if (log.steps * STEP_MS > ctx.now - game.startedAt + SLACK_MS) return reject('faster than real time');
        const r = await replayer.run({ seed: game.seed, mode: 'marathon', log });
        if (!r.ok) {
          if (RETRYABLE.has(r.error)) return { status: 503, body: { error: 'try again later' } };
          return reject(r.error);
        }
        if (!db.finishMarathon(gameId, { score: r.score, lines: r.lines, level: r.level }, ctx.now)) {
          return { status: 409, body: { error: 'already submitted' } };
        }
        return { status: 200, body: db.leaderboard(ctx.now) };
      },
    },
  ];
}
