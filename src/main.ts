import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.ts';
import { createHandler } from './http.ts';
import type { Route } from './http.ts';
import { createGithub } from './github.ts';
import { sessionRoutes } from './routes/session.ts';
import { marathonRoutes } from './routes/marathon.ts';
import { botRoutes } from './routes/bot.ts';
import { createReplayer } from './replay.ts';
import { createArena } from './arena.ts';
import { battleRoutes } from './routes/battle.ts';
import { dailyDiffRoutes } from './routes/daily-diff.ts';
import { loadWords } from './daily-diff/words.ts';

export type Config = {
  port: number;
  databasePath: string;
  githubClientId: string;
  githubClientSecret: string;
  maxHeld: number;
  maxPlayers: number;
  maxConnections: number;
  trustProxy: boolean;
  dailyDiffWordsDir?: string | undefined;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`Missing required environment variable ${name}`);
    return v;
  };
  const int = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
    return n;
  };
  return {
    port: int('PORT', 8080),
    databasePath: env.DATABASE_PATH || './data/server.db',
    githubClientId: need('GITHUB_CLIENT_ID'),
    githubClientSecret: need('GITHUB_CLIENT_SECRET'),
    maxHeld: int('MAX_HELD', 2000),
    maxPlayers: int('MAX_PLAYERS', 1000),
    maxConnections: int('MAX_CONNECTIONS', 4000),
    trustProxy: env.TRUST_PROXY === 'true',
    dailyDiffWordsDir: env.DAILY_DIFF_WORDS_DIR || undefined,
  };
}

export function applyLimits(
  server: Server,
  maxConnections: number,
  t = { headers: 10_000, request: 15_000, keepAlive: 5_000 },
) {
  server.headersTimeout = t.headers;
  server.requestTimeout = t.request;
  server.keepAliveTimeout = t.keepAlive;
  server.maxConnections = maxConnections;
}

export async function start(
  config: Config,
  opts: {
    fetch?: typeof fetch;
    log?: (line: string) => void;
    now?: () => number;
    replayer?: Pick<ReturnType<typeof createReplayer>, 'run' | 'close'>;
  } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = openDb(config.databasePath);
  const replayer = opts.replayer ?? createReplayer({ maxConcurrent: 2, timeoutMs: 10_000, botTimeoutMs: 60_000, maxQueue: 32 });
  const arena = createArena({ db, replayer, maxPlayers: config.maxPlayers, maxHeld: config.maxHeld });
  const words = loadWords(config.dailyDiffWordsDir);
  (opts.log ?? console.log)(words ? 'daily diff: words loaded' : 'daily diff: off, no word files');
  const routes: Route[] = [
    { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
    ...sessionRoutes({
      db,
      github: createGithub({
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        fetch: opts.fetch ?? fetch,
      }),
      clientId: config.githubClientId,
    }),
    ...marathonRoutes({ db, replayer }),
    ...botRoutes({ db, replayer }),
    ...battleRoutes(arena),
    ...dailyDiffRoutes({ db, words }),
  ];
  const server = createServer(
    createHandler({
      routes,
      findSession: (key, now) => db.findSession(key, now),
      trustProxy: config.trustProxy,
      log: opts.log,
      now: opts.now,
    }),
  );
  applyLimits(server, config.maxConnections);
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        arena.close();
        server.close((err) => {
          db.close();
          void replayer.close();
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      })),
  };
}

if (import.meta.main) {
  const { port, close } = await start(loadConfig(process.env));
  const stop = () => close().then(() => process.exit(0), () => process.exit(1));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(`listening on ${port}`);
}
