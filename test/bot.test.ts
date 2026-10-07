import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLog } from '../src/protocol.ts';
import type { ReplayLog } from '../src/protocol.ts';
import { createReplayer, replay } from '../src/replay.ts';
import type { ReplayJob, ReplayResult } from '../src/replay.ts';
import { start } from '../src/main.ts';
import { openDb } from '../src/db.ts';
import { botRoutes } from '../src/routes/bot.ts';
import type { Ctx } from '../src/http.ts';
import { record } from './record.ts';

const cfg = { port: 0, databasePath: ':memory:', githubClientId: 'cid', githubClientSecret: 'csecret', maxHeld: 10, maxPlayers: 10, maxConnections: 50, trustProxy: false };

async function boot() {
  const gh = (async (url: string | URL | Request) =>
    String(url).includes('/applications/')
      ? new Response('{}')
      : Response.json({ login: 'alice', id: 7, created_at: '2015-01-02T03:04:05Z' })) as typeof globalThis.fetch;
  const s = await start(cfg, { fetch: gh, log: () => {} });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${s.port}${path}`, {
      ...init,
      headers: { 'x-protocol-version': '2', ...(session ? { authorization: `Bearer ${session}` } : {}) },
    });
  let session = '';
  session = ((await (await call('/v1/session', { method: 'POST', body: '{"githubToken":"t"}' })).json()) as { session: string }).session;
  const begin = (level = 'easy') => call('/v1/bot', { method: 'POST', body: JSON.stringify({ level }) });
  const submit = (gameId: string, log: ReplayLog) => call('/v1/bot/scores', { method: 'POST', body: JSON.stringify({ gameId, log: encodeLog(log) }) });
  return { ...s, call, begin, submit };
}

test('starting a bot game returns a game id and a seed; a bad level is 400', async () => {
  const s = await boot();
  try {
    const r = await s.begin('hard');
    assert.equal(r.status, 200);
    const body = (await r.json()) as { gameId: string; seed: number };
    assert.match(body.gameId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(Number.isInteger(body.seed) && body.seed >= 0 && body.seed < 2 ** 32);
    const bad = await s.begin('nightmare');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'level must be easy, medium or hard' });
  } finally {
    await s.close();
  }
});

test('a log that stops early is a loss, closes the game, and the reply has the bot field', async () => {
  const s = await boot();
  try {
    const { gameId } = (await (await s.begin()).json()) as { gameId: string };
    const r = await s.submit(gameId, { steps: 1, inputs: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { bot: unknown }).bot, { easy: [], medium: [], hard: [] });
    assert.equal((await s.submit(gameId, { steps: 1, inputs: [] })).status, 409);
    const lb = (await (await s.call('/v1/leaderboard')).json()) as { bot: unknown };
    assert.deepEqual(lb.bot, { easy: [], medium: [], hard: [] });
  } finally {
    await s.close();
  }
});

test('Marathon and Vs Bot share 5 open games', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.call('/v1/marathon', { method: 'POST' })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await s.begin()).status, 200);
    const bot = await s.begin();
    assert.equal(bot.status, 429);
    assert.deepEqual(await bot.json(), { error: 'too many open games' });
    assert.equal((await s.call('/v1/marathon', { method: 'POST' })).status, 429);
  } finally {
    await s.close();
  }
});

test('too many steps for the elapsed time is rejected for good', async () => {
  const s = await boot();
  try {
    const { gameId } = (await (await s.begin()).json()) as { gameId: string };
    const r = await s.submit(gameId, { steps: 2000, inputs: [] });
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: 'faster than real time' });
    assert.equal((await s.submit(gameId, { steps: 1, inputs: [] })).status, 409);
  } finally {
    await s.close();
  }
});

test('an unknown game, or a Marathon game id, is 404', async () => {
  const s = await boot();
  try {
    assert.equal((await s.submit('nope', { steps: 1, inputs: [] })).status, 404);
    const { gameId } = (await (await s.call('/v1/marathon', { method: 'POST' })).json()) as { gameId: string };
    assert.equal((await s.submit(gameId, { steps: 1, inputs: [] })).status, 404);
  } finally {
    await s.close();
  }
});

test('garbage in a bot log is 422', async () => {
  const s = await boot();
  try {
    const { gameId } = (await (await s.begin()).json()) as { gameId: string };
    const r = await s.submit(gameId, { steps: 10, inputs: [], garbage: [[2, 1]] });
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: 'garbage in a bot log' });
  } finally {
    await s.close();
  }
});

// Route-level: time is ours to set, so a long honest match needs no real wait.
function scoresRoute(run: (job: ReplayJob) => Promise<ReplayResult>) {
  const db = openDb(':memory:');
  db.upsertPlayer({ login: 'alice', githubId: 7, githubCreatedAt: 0 }, 0);
  const route = botRoutes({ db, replayer: { run } }).find((r) => r.path === '/v1/bot/scores')!;
  const submit = (gameId: string, log: ReplayLog, now: number) =>
    route.handler({ body: { gameId, log: encodeLog(log) }, login: 'alice', now } as Ctx);
  return { db, submit };
}

const T0 = Date.UTC(2026, 9, 7);

test('an honest win ranks by its step count', async () => {
  const { db, submit } = scoresRoute(async (job) => replay(job));
  try {
    // If this seed ever gives a loss, try seeds 1 to 20 and keep the first win under 60,000 steps.
    const { log, m } = record(5, 'easy', 60_000, 'hard');
    assert.equal(m.winner, 'me');
    const gameId = db.startBotGame('alice', 'easy', 5, T0);
    const now = T0 + log.steps * 16;
    const r = await submit(gameId, log, now);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { bot: { easy: unknown } }).bot.easy, [{ login: 'alice', ms: m.steps * 16, at: now }]);
    assert.deepEqual(db.getBotGame(gameId), { id: gameId, login: 'alice', level: 'easy', seed: 5, startedAt: T0, finishedAt: now, won: 1, steps: m.steps });
  } finally {
    db.close();
  }
});

test('input after the match ended is 422 and the game is closed', async () => {
  const { db, submit } = scoresRoute(async (job) => replay(job));
  try {
    const { log, m } = record(4242, 'hard', 20_000);
    const gameId = db.startBotGame('alice', 'hard', 4242, T0);
    const bad: ReplayLog = { steps: m.steps + 5, inputs: [...log.inputs, [m.steps + 2, 'left']] };
    assert.deepEqual(await submit(gameId, bad, T0 + 3_600_000), { status: 422, body: { error: 'input after game over' } });
    assert.equal((await submit(gameId, log, T0 + 3_600_000)).status, 409);
  } finally {
    db.close();
  }
});

test('a busy replayer is 503 and the game can be sent again', async () => {
  let busy = true;
  const { db, submit } = scoresRoute(async (job) => (busy ? { ok: false, error: 'busy' } : replay(job)));
  try {
    const gameId = db.startBotGame('alice', 'easy', 1, T0);
    assert.deepEqual(await submit(gameId, { steps: 1, inputs: [] }, T0 + 1_000), { status: 503, body: { error: 'try again later' } });
    busy = false;
    assert.equal((await submit(gameId, { steps: 1, inputs: [] }, T0 + 2_000)).status, 200);
  } finally {
    db.close();
  }
});

test('a game left open too long is 410 and never replayed', async () => {
  const runs: unknown[] = [];
  const { db, submit } = scoresRoute(async (job) => (runs.push(job), replay(job)));
  try {
    const gameId = db.startBotGame('alice', 'easy', 1, T0);
    const limit = 450_000 * 16 + 5 * 60_000;
    assert.deepEqual(await submit(gameId, { steps: 1, inputs: [] }, T0 + limit + 1), { status: 410, body: { error: 'game expired' } });
    assert.equal(runs.length, 0);
  } finally {
    db.close();
  }
});

test('the real replayer runs bot jobs in a worker', async () => {
  const p = createReplayer({ maxConcurrent: 1, timeoutMs: 10_000, maxQueue: 4 });
  const { db, submit } = scoresRoute((job) => p.run(job));
  try {
    const gameId = db.startBotGame('alice', 'hard', 4242, T0);
    const { log } = record(4242, 'hard', 20_000);
    assert.equal((await submit(gameId, log, T0 + log.steps * 16)).status, 200);
    assert.equal(db.getBotGame(gameId)!.won, 0);
  } finally {
    await p.close();
    db.close();
  }
});
