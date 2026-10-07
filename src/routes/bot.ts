import { randomInt } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Route } from '../http.ts';
import type { ReplayResult } from '../replay.ts';
import type { Level } from '../bot.ts';
import { parseBotStart, parseScoreBody } from '../protocol.ts';
import type { BotStartReply, ReplayLog } from '../protocol.ts';
import { EXPIRE_MS, MAX_OPEN, OPEN_WINDOW, RETRYABLE, SLACK_MS, STEP_MS } from './marathon.ts';

type Deps = {
  db: Db;
  replayer: { run(job: { seed: number; mode: 'battle'; log: ReplayLog; level: Level }): Promise<ReplayResult> };
  random?: () => number;
};

export function botRoutes(deps: Deps): Route[] {
  const { db, replayer } = deps;
  const seed = deps.random ?? (() => randomInt(0, 2 ** 32));
  return [
    {
      method: 'POST',
      path: '/v1/bot',
      auth: true,
      handler: async (ctx) => {
        const parsed = parseBotStart(ctx.body);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
        if (db.openGames(ctx.login!, ctx.now - OPEN_WINDOW) >= MAX_OPEN) {
          return { status: 429, body: { error: 'too many open games' } };
        }
        const s = seed();
        const body: BotStartReply = { gameId: db.startBotGame(ctx.login!, parsed.value.level, s, ctx.now), seed: s };
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/bot/scores',
      auth: true,
      bodyLimit: 1_572_864,
      handler: async (ctx) => {
        const parsed = parseScoreBody(ctx.body);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
        const { gameId, log } = parsed.value;
        const game = db.getBotGame(gameId);
        if (!game || game.login !== ctx.login) return { status: 404, body: { error: 'no such game' } };
        if (game.finishedAt !== null) return { status: 409, body: { error: 'already submitted' } };

        const reject = (error: string, status = 422) =>
          db.finishBotGame(gameId, null, ctx.now)
            ? { status, body: { error } }
            : { status: 409, body: { error: 'already submitted' } };

        if (ctx.now - game.startedAt > EXPIRE_MS) return reject('game expired', 410);
        if (log.steps * STEP_MS > ctx.now - game.startedAt + SLACK_MS) return reject('faster than real time');
        const r = await replayer.run({ seed: game.seed, mode: 'battle', log, level: game.level });
        if (!r.ok) {
          if (RETRYABLE.has(r.error)) return { status: 503, body: { error: 'try again later' } };
          return reject(r.error);
        }
        // A log that stops before either side tops out is a match the player left: a loss.
        const steps = r.topOutStep === null ? log.steps : r.topOutStep + 1;
        if (!db.finishBotGame(gameId, { won: r.winner === 'me', steps }, ctx.now)) {
          return { status: 409, body: { error: 'already submitted' } };
        }
        return { status: 200, body: db.leaderboard(ctx.now) };
      },
    },
  ];
}
