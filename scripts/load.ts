// Dev tool, not run in CI. Usage: npm run load -- [--players 500] [--seconds 60]
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/main.ts';
import { PROTOCOL_VERSION } from '../src/protocol.ts';

const { values } = parseArgs({ options: { players: { type: 'string', default: '500' }, seconds: { type: 'string', default: '60' } } });
const N = Math.max(2, Number(values.players) & ~1);
const SECONDS = Number(values.seconds);

const fakeGithub = (async (url: string | URL | Request, init: RequestInit = {}) => {
  if (String(url).includes('/applications/')) return new Response('{}', { status: 200 });
  const n = String((init.headers as Record<string, string>).authorization).slice('Bearer tok'.length);
  return Response.json({ login: `player${n}`, id: Number(n) + 1, created_at: '2015-01-02T03:04:05Z' });
}) as typeof fetch;

const server = await start(
  {
    port: 0,
    databasePath: ':memory:',
    githubClientId: 'load',
    githubClientSecret: 'load',
    maxHeld: 2000,
    maxPlayers: Math.max(1000, N),
    maxConnections: 4000,
    trustProxy: true,
  },
  { fetch: fakeGithub, log: () => {} },
);

const base = `http://127.0.0.1:${server.port}`;
const EMPTY = '.'.repeat(200);
const news: number[] = [];
const quiet: number[] = [];
const errors = new Map<string, number>();
let syncs = 0;
let matched = 0;
const countError = (k: string | number) => errors.set(String(k), (errors.get(k as string) ?? 0) + 1);

async function player(i: number, endAt: { t: number }) {
  const headers: Record<string, string> = { 'x-protocol-version': String(PROTOCOL_VERSION), 'x-forwarded-for': `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` };
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { ...headers, ...(init.headers as object) } });
  try {
    const signIn = await call('/v1/session', { method: 'POST', body: JSON.stringify({ githubToken: `tok${i}` }) });
    if (!signIn.ok) return countError(signIn.status);
    const auth = { authorization: `Bearer ${((await signIn.json()) as { session: string }).session}` };

    let room = '';
    while (!room) {
      const q = await call('/v1/battle/queue', { method: 'POST', headers: auth });
      if (!q.ok) return countError(q.status);
      const b = (await q.json()) as { status: string; roomId?: string };
      if (b.roomId) room = b.roomId;
      else await sleep(500 + Math.random() * 500);
      if (Date.now() > endAt.t) return;
    }
    matched++;

    for (let seq = 1; Date.now() < endAt.t; seq++) {
      const snapshot = seq % 5 === 0 ? 'G' + EMPTY.slice(1) : EMPTY;
      const t0 = performance.now();
      const r = await call(`/v1/battle/${room}/sync`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ seq, attacks: [], snapshot, isOver: false }),
      });
      const ms = performance.now() - t0;
      await r.arrayBuffer();
      syncs++;
      if (r.status === 200) (ms >= 1900 ? quiet : news).push(ms);
      else if (r.status !== 204) {
        countError(r.status);
        if (r.status === 404) return;
      }
    }
  } catch (e) {
    countError((e as Error).name);
  }
}

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!.toFixed(0) + ' ms' : 'n/a');
let peak = 0;
const rss = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 250);

const endAt = { t: Date.now() + (SECONDS + 10) * 1000 }; // players join over 10 s, then sync for SECONDS
const all = Promise.all(Array.from({ length: N }, async (_, i) => { await sleep((i / N) * 10_000); return player(i, endAt); }));
await all;
clearInterval(rss);
await server.close();

console.log(`players        ${N}`);
console.log(`matched        ${matched}`);
console.log(`sync requests  ${syncs}`);
console.log(`on news        n=${news.length} p50 ${pct(news, 0.5)} p95 ${pct(news, 0.95)} p99 ${pct(news, 0.99)}`);
console.log(`quiet hold     n=${quiet.length} p50 ${pct(quiet, 0.5)} p95 ${pct(quiet, 0.95)} p99 ${pct(quiet, 0.99)}`);
console.log(`errors         ${errors.size ? [...errors].map(([k, v]) => `${k}: ${v}`).join(', ') : 'none'}`);
console.log(`peak RSS       ${(peak / 1048576).toFixed(0)} MB`);
