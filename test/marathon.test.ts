import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, step } from '../src/engine.ts';
import type { Game } from '../src/engine.ts';
import type { GameLog } from '../src/protocol.ts';
import { createReplayer } from '../src/replay.ts';
import type { ReplayResult } from '../src/replay.ts';
import { start } from '../src/main.ts';

const cfg = { port: 0, databasePath: ':memory:', githubClientId: 'cid', githubClientSecret: 'csecret', maxHeld: 10, maxPlayers: 10, maxConnections: 50, trustProxy: false };

async function boot(replayer: NonNullable<Parameters<typeof start>[1]['replayer']> = createReplayer({ maxConcurrent: 2, timeoutMs: 10_000, maxQueue: 32 })) {
  let who = { login: 'alice', id: 7 };
  const gh = (async (url: string | URL | Request) =>
    String(url).includes('/applications/')
      ? new Response('{}')
      : Response.json({ ...who, created_at: '2015-01-02T03:04:05Z' })) as typeof globalThis.fetch;
  const s = await start(cfg, { fetch: gh, log: () => {}, replayer });
  const call = (path: string, init: RequestInit = {}, token?: string) =>
    fetch(`http://127.0.0.1:${s.port}${path}`, {
      ...init,
      headers: { 'x-protocol-version': '2', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  const signIn = async (login: string, id: number) => {
    who = { login, id };
    return ((await (await call('/v1/session', { method: 'POST', body: '{"githubToken":"t"}' })).json()) as { session: string }).session;
  };
  const session = await signIn('alice', 7);
  const begin = async (token = session) => (await (await call('/v1/marathon', { method: 'POST' }, token)).json()) as { gameId: string; seed: number };
  const submit = (gameId: string, log: GameLog, token = session) =>
    call('/v1/scores', { method: 'POST', body: JSON.stringify({ gameId, log }) }, token);
  return { ...s, call, session, signIn, begin, submit };
}

// hard drops every step until the stack tops out or `steps` is reached
function play(seed: number, steps: number): { log: GameLog; game: Game; topOut: number | null } {
  let game = newGame('marathon', seed);
  const log: GameLog = { steps, inputs: [] };
  for (let i = 0; i < steps; i++) {
    log.inputs.push([i, 'hardDrop']);
    game = step(game, ['hardDrop'], 16).game;
    if (game.isOver) return { log, game, topOut: i };
  }
  return { log, game, topOut: null };
}

test('honest log counts with the replayed score and shows on the leaderboard', async () => {
  const s = await boot();
  try {
    const { gameId, seed } = await s.begin();
    const run = play(seed, 40);
    assert.ok(run.game.score > 0);
    const r = await s.submit(gameId, run.log);
    assert.equal(r.status, 200);
    const board = (await r.json()) as { marathon: { login: string; score: number }[] };
    assert.equal(board.marathon[0]!.login, 'alice');
    assert.equal(board.marathon[0]!.score, run.game.score);
    const lb = await s.call('/v1/leaderboard', {}, s.session);
    assert.deepEqual(await lb.json(), board);
  } finally {
    await s.close();
  }
});

test('too many steps for the elapsed time is rejected for good', async () => {
  const s = await boot();
  try {
    const { gameId } = await s.begin();
    const r = await s.submit(gameId, { steps: 2000, inputs: [] });
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: 'faster than real time' });
    assert.equal((await s.submit(gameId, { steps: 10, inputs: [] })).status, 409);
  } finally {
    await s.close();
  }
});

test('resubmitting an accepted game is 409', async () => {
  const s = await boot();
  try {
    const { gameId, seed } = await s.begin();
    const { log } = play(seed, 20);
    assert.equal((await s.submit(gameId, log)).status, 200);
    assert.equal((await s.submit(gameId, log)).status, 409);
  } finally {
    await s.close();
  }
});

test('an unknown or foreign game is 404', async () => {
  const s = await boot();
  try {
    assert.equal((await s.submit('nope', { steps: 1, inputs: [] })).status, 404);
    const { gameId } = await s.begin();
    const bob = await s.signIn('bob', 8);
    assert.equal((await s.submit(gameId, { steps: 1, inputs: [] }, bob)).status, 404);
    assert.equal((await s.submit(gameId, { steps: 1, inputs: [] })).status, 200);
  } finally {
    await s.close();
  }
});

test('a busy replayer is 503 and the game can be submitted later', async () => {
  let busy = true;
  const real = createReplayer({ maxConcurrent: 1, timeoutMs: 10_000, maxQueue: 4 });
  const replayer = {
    run: (job: Parameters<typeof real.run>[0]): Promise<ReplayResult> =>
      busy ? Promise.resolve({ ok: false, error: 'busy' }) : real.run(job),
    close: () => real.close(),
  };
  const s = await boot(replayer);
  try {
    const { gameId, seed } = await s.begin();
    const { log } = play(seed, 20);
    const r = await s.submit(gameId, log);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'try again later' });
    busy = false;
    assert.equal((await s.submit(gameId, log)).status, 200);
  } finally {
    await s.close();
  }
});

test('input after game over is 422', async () => {
  const s = await boot();
  try {
    const { gameId, seed } = await s.begin();
    const { log, topOut } = play(seed, 400);
    assert.ok(topOut !== null);
    const bad: GameLog = { steps: topOut + 5, inputs: [...log.inputs, [topOut + 2, 'left']] };
    const r = await s.submit(gameId, bad);
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: 'input after game over' });
  } finally {
    await s.close();
  }
});

test('two concurrent submissions count once', async () => {
  const s = await boot();
  try {
    const { gameId, seed } = await s.begin();
    const { log } = play(seed, 20);
    const codes = (await Promise.all([s.submit(gameId, log), s.submit(gameId, log)])).map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409]);
  } finally {
    await s.close();
  }
});

test('the sixth open game is 429', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.call('/v1/marathon', { method: 'POST' }, s.session)).status, 200);
    const r = await s.call('/v1/marathon', { method: 'POST' }, s.session);
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'too many open games' });
  } finally {
    await s.close();
  }
});
