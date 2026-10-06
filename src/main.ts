import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.ts';
import { createHandler } from './http.ts';
import type { Route } from './http.ts';

export type Config = {
  port: number;
  databasePath: string;
  githubClientId: string;
  githubClientSecret: string;
  maxHeld: number;
  maxPlayers: number;
  trustProxy: boolean;
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
    trustProxy: env.TRUST_PROXY === 'true',
  };
}

export async function start(config: Config): Promise<{ port: number; close: () => Promise<void> }> {
  if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = openDb(config.databasePath);
  const routes: Route[] = [
    { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
  ];
  const server = createServer(
    createHandler({ routes, findSession: (key, now) => db.findSession(key, now), trustProxy: config.trustProxy }),
  );
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          db.close();
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

if (import.meta.main) {
  const { port } = await start(loadConfig(process.env));
  console.log(`listening on ${port}`);
}
