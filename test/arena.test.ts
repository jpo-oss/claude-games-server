import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/http.ts';
import { createGithub } from '../src/github.ts';
import { sessionRoutes } from '../src/routes/session.ts';
import { battleRoutes } from '../src/routes/battle.ts';
import { createArena } from '../src/arena.ts';
import type { ArenaTiming } from '../src/arena.ts';
import { createReplayer } from '../src/replay.ts';
import type { ReplayJob, ReplayResult } from '../src/replay.ts';
import { newGame, step } from '../src/engine.ts';
import type { GameLog, QueueReply, SyncReply } from '../src/protocol.ts';
import { start } from '../src/main.ts';

type Replayer = { run(job: ReplayJob): Promise<ReplayResult>; close(): Promise<void> };
type Matched = Extract<QueueReply, { status: 'matched' }>;

async function boot(opts: { maxPlayers?: number; maxHeld?: number; replayer?: Replayer; timing?: ArenaTiming } = {}) {
  const clock = { t: Date.UTC(2026, 9, 6, 12) };
  const db = openDb(':memory:');
  const finished = new Map<string, { winner: string | null; counted: boolean }>();
  const finishCalls = new Map<string, number>();
  const realFinish = db.finishBattle;
  db.finishBattle = (roomId, winner, counted, now) => {
    finishCalls.set(roomId, (finishCalls.get(roomId) ?? 0) + 1);
    finished.set(roomId, { winner, counted });
    realFinish(roomId, winner, counted, now);
  };
  const replayer = opts.replayer ?? createReplayer({ maxConcurrent: 2, timeoutMs: 10_000, maxQueue: 32 });
  const arena = createArena({
    db,
    replayer,
    maxPlayers: opts.maxPlayers ?? 10,
    maxHeld: opts.maxHeld ?? 10,
    now: () => clock.t,
    timing: { sweepMs: 3_600_000, ...opts.timing },
  });
  let who = { login: 'alice', id: 1 };
  const gh = (async (url: string | URL | Request) =>
    String(url).includes('/applications/')
      ? new Response('{}')
      : Response.json({ ...who, created_at: '2015-01-02T03:04:05Z' })) as typeof globalThis.fetch;
  const github = createGithub({ clientId: 'cid', clientSecret: 'secret', fetch: gh });
  const server = createServer(
    createHandler({
      routes: [...sessionRoutes({ db, github, clientId: 'cid' }), ...battleRoutes(arena)],
      findSession: (key, now) => db.findSession(key, now),
      trustProxy: false,
      log: () => {},
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const call = (path: string, init: RequestInit = {}, token?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'x-protocol-version': '2', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  const signIn = async (login: string, id: number) => {
    who = { login, id };
    return ((await (await call('/v1/session', { method: 'POST', body: '{"githubToken":"t"}' })).json()) as { session: string }).session;
  };
  const queue = (token: string) => call('/v1/battle/queue', { method: 'POST' }, token);
  const sync = (room: string, token: string, body: { seq: number; attacks?: number[]; snapshot?: string; isOver?: boolean }, signal?: AbortSignal) =>
    call(`/v1/battle/${room}/sync`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ attacks: [], snapshot: '', isOver: false, ...body }),
    }, token);
  const syncJson = async (...a: Parameters<typeof sync>) => {
    const r = await sync(...a);
    assert.equal(r.status, 200);
    return (await r.json()) as SyncReply;
  };
  const sendLog = (room: string, token: string, log: GameLog) =>
    call(`/v1/battle/${room}/log`, { method: 'POST', body: JSON.stringify({ log }) }, token);

  const alice = await signIn('alice', 1);
  const bob = await signIn('bob', 2);

  const pair = async (a = alice, b = bob, collectAfterMs = 0) => {
    assert.deepEqual(await (await queue(a)).json(), { status: 'waiting' });
    const mb = (await (await queue(b)).json()) as Matched;
    clock.t += collectAfterMs;
    const ma = (await (await queue(a)).json()) as Matched;
    assert.equal(ma.roomId, mb.roomId);
    return mb;
  };

  const waitFinished = async (roomId: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!finished.has(roomId)) {
      if (Date.now() > end) throw new Error('battle never finished');
      await new Promise((r) => setTimeout(r, 10));
    }
    return finished.get(roomId)!;
  };

  const close = async () => {
    arena.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await replayer.close();
    db.close();
  };

  return { clock, db, arena, call, signIn, queue, sync, syncJson, sendLog, alice, bob, pair, waitFinished, finished, finishCalls, close };
}

// hard drops every step until the stack tops out
function topOutLog(seed: number): GameLog {
  let game = newGame('battle', seed);
  const log: GameLog = { steps: 0, inputs: [] };
  for (let i = 0; i < 5_000; i++) {
    log.inputs.push([i, 'hardDrop']);
    game = step(game, ['hardDrop'], 16).game;
    if (game.isOver) return { ...log, steps: i + 1 };
  }
  throw new Error('never topped out');
}

// bob sends alice a 3-line attack a second in, then tops out after `lastsMs`
async function battle(
  s: Awaited<ReturnType<typeof boot>>,
  opts: { collectAfterMs?: number; lastsMs?: number; aliceAttacks?: number[]; bobFinalAttacks?: number[]; winnerLog?: GameLog | null; loserLog?: GameLog } = {},
) {
  const lastsMs = opts.lastsMs ?? 61_000;
  const m = await s.pair(s.alice, s.bob, opts.collectAfterMs ?? 0);
  s.clock.t += 1_000;
  await s.syncJson(m.roomId, s.bob, { seq: 0, attacks: [3] });
  const a0 = await s.syncJson(m.roomId, s.alice, { seq: 0, attacks: opts.aliceAttacks ?? [], snapshot: 'T' });
  assert.deepEqual(a0.incoming, [{ id: 1, lines: 3 }]);
  s.clock.t += lastsMs - 1_000;
  const b1 = await s.syncJson(m.roomId, s.bob, { seq: 1, isOver: true, attacks: opts.bobFinalAttacks ?? [] });
  assert.deepEqual(b1.result, { winner: 'alice' });
  const a1 = await s.syncJson(m.roomId, s.alice, { seq: 1, snapshot: 'T' });
  assert.deepEqual(a1.result, { winner: 'alice' });
  assert.deepEqual(a1.incoming, []);
  assert.equal((await s.sendLog(m.roomId, s.bob, opts.loserLog ?? topOutLog(m.seed))).status, 204);
  if (opts.winnerLog !== null) {
    const log = opts.winnerLog ?? honest(lastsMs, [[1_000, 1]]);
    assert.equal((await s.sendLog(m.roomId, s.alice, log)).status, 204);
  }
  return m;
}

// no inputs, each attack applied at the step it arrived; lasts as long as the match
function honest(ms: number, garbage: [number, number][]): GameLog {
  return { steps: Math.round(ms / 16), inputs: [], garbage: garbage.map(([at, id]) => [Math.round(at / 16), id]) };
}

// no inputs until `idle`, then hard drops every step until the stack tops out
function idleThenTopOut(seed: number, idle: number): { log: GameLog; topOutStep: number } {
  let game = newGame('battle', seed);
  const log: GameLog = { steps: 0, inputs: [] };
  for (let i = 0; i < idle + 5_000; i++) {
    const inputs = i >= idle ? (['hardDrop'] as const) : [];
    for (const inp of inputs) log.inputs.push([i, inp]);
    game = step(game, [...inputs], 16).game;
    if (game.isOver) return { log: { ...log, steps: i + 1 }, topOutStep: i };
  }
  throw new Error('never topped out');
}

const pending = (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  return () => !done;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('two players get matched into the same room', async () => {
  const s = await boot();
  try {
    assert.deepEqual(await (await s.queue(s.alice)).json(), { status: 'waiting' });
    assert.deepEqual(await (await s.queue(s.alice)).json(), { status: 'waiting' });
    const mb = (await (await s.queue(s.bob)).json()) as Matched;
    assert.equal(mb.status, 'matched');
    assert.match(mb.roomId, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(Number.isInteger(mb.seed) && mb.seed >= 0 && mb.seed < 2 ** 32);
    assert.deepEqual(mb.opponent, { login: 'alice' });
    const ma = (await (await s.queue(s.alice)).json()) as Matched;
    assert.deepEqual(ma, { ...mb, opponent: { login: 'bob' } });
    const carol = await s.signIn('carol', 3);
    assert.deepEqual(await (await s.queue(carol)).json(), { status: 'waiting' });
    assert.equal((await s.call('/v1/battle/queue', { method: 'DELETE' }, carol)).status, 204);
    const dave = await s.signIn('dave', 4);
    assert.deepEqual(await (await s.queue(dave)).json(), { status: 'waiting' });
  } finally {
    await s.close();
  }
});

test('a new player is turned away once the server holds maxPlayers', async () => {
  const s = await boot({ maxPlayers: 2 });
  try {
    await s.pair();
    const carol = await s.signIn('carol', 3);
    const r = await s.queue(carol);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'server busy' });
  } finally {
    await s.close();
  }
});

test('sync checks the room and the player', async () => {
  const s = await boot();
  try {
    const m = await s.pair();
    const r = await s.sync('nope', s.alice, { seq: 0 });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'no such room' });
    const carol = await s.signIn('carol', 3);
    const f = await s.sync(m.roomId, carol, { seq: 0 });
    assert.equal(f.status, 403);
    assert.deepEqual(await f.json(), { error: 'not in this room' });
    assert.equal((await s.sync(m.roomId, s.alice, { seq: -1 })).status, 400);
    assert.equal((await s.sendLog('nope', s.alice, { steps: 1, inputs: [] })).status, 404);
    assert.equal((await s.sendLog(m.roomId, carol, { steps: 1, inputs: [] })).status, 403);
    const early = await s.sendLog(m.roomId, s.alice, { steps: 1, inputs: [] });
    assert.equal(early.status, 409);
  } finally {
    await s.close();
  }
});

test('news releases a held sync long before its hold timer', async () => {
  const s = await boot({ timing: { holdMs: 20_000 } });
  try {
    const m = await s.pair();
    const held = s.syncJson(m.roomId, s.alice, { seq: 0, snapshot: 'T' });
    const waiting = pending(held);
    await sleep(300);
    assert.ok(waiting(), 'alice should be held');
    const at = Date.now();
    const b = await s.syncJson(m.roomId, s.bob, { seq: 0, attacks: [3], snapshot: 'IIII' });
    assert.equal(b.opponent?.snapshot, 'T');
    const a = await held;
    assert.ok(Date.now() - at < 1_000, `took ${Date.now() - at} ms`);
    assert.deepEqual(a.opponent, { login: 'bob', snapshot: 'IIII', isOver: false });
    assert.deepEqual(a.incoming, [{ id: 1, lines: 3 }]);
    assert.deepEqual((await s.syncJson(m.roomId, s.alice, { seq: 0, snapshot: 'T' })).incoming, [{ id: 1, lines: 3 }]);
  } finally {
    await s.close();
  }
});

test('a quiet held sync answers after about 2 s', async () => {
  const s = await boot();
  try {
    const m = await s.pair();
    const at = Date.now();
    const a = await s.syncJson(m.roomId, s.alice, { seq: 0 });
    const took = Date.now() - at;
    assert.ok(took >= 1_900 && took < 2_600, `took ${took} ms`);
    assert.deepEqual(a, { opponent: { login: 'bob', snapshot: '', isOver: false }, incoming: [] });
  } finally {
    await s.close();
  }
});

test('a second sync from the same player releases the first', async () => {
  const s = await boot();
  try {
    const m = await s.pair();
    const first = s.syncJson(m.roomId, s.alice, { seq: 0 });
    await sleep(100);
    const ac = new AbortController();
    const second = s.sync(m.roomId, s.alice, { seq: 1 }, ac.signal).catch(() => null);
    const at = Date.now();
    assert.deepEqual((await first).incoming, []);
    assert.ok(Date.now() - at < 300);
    ac.abort();
    await second;
  } finally {
    await s.close();
  }
});

test('maxHeld 0 answers at once', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    const at = Date.now();
    await s.syncJson(m.roomId, s.alice, { seq: 0 });
    assert.ok(Date.now() - at < 300);
  } finally {
    await s.close();
  }
});

test('an aborted sync drops its waiter and keeps its attacks for the next sync', async () => {
  const s = await boot({ maxHeld: 1 });
  try {
    const m = await s.pair();
    const ac = new AbortController();
    const gone = s.sync(m.roomId, s.alice, { seq: 0 }, ac.signal).catch(() => null);
    await sleep(100);
    ac.abort();
    await gone;
    await sleep(50);
    // the freed slot lets bob be held
    const bc = new AbortController();
    const bobHeld = s.sync(m.roomId, s.bob, { seq: 0 }, bc.signal).catch(() => null);
    const waiting = pending(bobHeld);
    await sleep(300);
    assert.ok(waiting(), 'bob should be held');
    bc.abort();
    await bobHeld;
    await sleep(50);
    const bobNext = s.syncJson(m.roomId, s.bob, { seq: 1, attacks: [2], snapshot: 'I' });
    await sleep(100);
    const a = await s.syncJson(m.roomId, s.alice, { seq: 1, snapshot: 'T' });
    assert.deepEqual(a.incoming, [{ id: 1, lines: 2 }]);
    assert.equal((await bobNext).opponent?.snapshot, 'T');
  } finally {
    await s.close();
  }
});

test('closing the arena answers held syncs', async () => {
  const s = await boot();
  const m = await s.pair();
  const held = s.sync(m.roomId, s.alice, { seq: 0 });
  await sleep(100);
  s.arena.close();
  assert.equal((await held).status, 200);
  await s.close();
});

test('rooms idle for over 60 s are removed and their held syncs answered', async () => {
  const s = await boot();
  try {
    const m = await s.pair();
    const held = s.sync(m.roomId, s.alice, { seq: 0 });
    await sleep(100);
    s.clock.t += 60_001;
    s.arena.sweep();
    assert.equal((await held).status, 200);
    assert.equal((await s.sync(m.roomId, s.alice, { seq: 1 })).status, 404);
    assert.deepEqual(s.finished.get(m.roomId), { winner: null, counted: false });
  } finally {
    await s.close();
  }
});

test('the attack budget caps what a player can send', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    await s.syncJson(m.roomId, s.alice, { seq: 0, attacks: [10, 10, 4, 40] });
    const b = await s.syncJson(m.roomId, s.bob, { seq: 0 });
    assert.deepEqual(b.incoming, [{ id: 1, lines: 10 }, { id: 2, lines: 4 }]);
  } finally {
    await s.close();
  }
});

test('a player silent for over 10 s forfeits', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    await s.syncJson(m.roomId, s.alice, { seq: 0 });
    await s.syncJson(m.roomId, s.bob, { seq: 0 });
    s.clock.t += 10_000;
    assert.equal((await s.syncJson(m.roomId, s.alice, { seq: 1 })).result, undefined);
    s.clock.t += 1;
    assert.deepEqual((await s.syncJson(m.roomId, s.alice, { seq: 2 })).result, { winner: 'alice' });
  } finally {
    await s.close();
  }
});

test('an honest win counts and shows on the leaderboard', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
    assert.deepEqual(s.db.leaderboard(s.clock.t).wins, [{ login: 'alice', wins: 1 }]);
    const again = await s.sendLog(m.roomId, s.alice, { steps: 30, inputs: [] });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: 'already sent' });
  } finally {
    await s.close();
  }
});

test('a winner log that leaves out delivered garbage does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { winnerLog: honest(61_000, []) });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('a winner who sent more lines than the replay earned does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { aliceAttacks: [4] });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('a loser log that does not top out spoils the win', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { loserLog: { steps: 30, inputs: [] } });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('an attack in the same reply as the result is not delivered and the win counts', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { bobFinalAttacks: [2] });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
  } finally {
    await s.close();
  }
});

test('a forfeit win with attacks still in the inbox counts', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    s.clock.t += 1_000;
    await s.syncJson(m.roomId, s.bob, { seq: 0, attacks: [3] });
    assert.deepEqual((await s.syncJson(m.roomId, s.alice, { seq: 0 })).incoming, [{ id: 1, lines: 3 }]);
    await s.syncJson(m.roomId, s.bob, { seq: 1, attacks: [2] });
    s.clock.t += 60_000;
    const a = await s.syncJson(m.roomId, s.alice, { seq: 1 });
    assert.deepEqual(a.result, { winner: 'alice' });
    assert.deepEqual(a.incoming, []);
    assert.equal((await s.sendLog(m.roomId, s.alice, honest(61_000, [[1_000, 1]]))).status, 204);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
  } finally {
    await s.close();
  }
});

test('a forfeit win counts even when the loser posts a log that never tops out', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    await s.syncJson(m.roomId, s.bob, { seq: 0 });
    await s.syncJson(m.roomId, s.alice, { seq: 0 });
    s.clock.t += 61_000;
    assert.deepEqual((await s.syncJson(m.roomId, s.alice, { seq: 1 })).result, { winner: 'alice' });
    assert.equal((await s.sendLog(m.roomId, s.bob, { steps: 30, inputs: [] })).status, 204);
    assert.equal((await s.sendLog(m.roomId, s.alice, honest(61_000, []))).status, 204);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
  } finally {
    await s.close();
  }
});

test('a forfeit winner whose replay tops out before the forfeit does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    const joined = s.clock.t;
    const { log, topOutStep } = idleThenTopOut(m.seed, 3_800);
    await s.syncJson(m.roomId, s.bob, { seq: 0 });
    await s.syncJson(m.roomId, s.alice, { seq: 0 });
    s.clock.t = joined + topOutStep * 16 + 1_000;
    assert.ok(s.clock.t - joined >= 60_000);
    assert.deepEqual((await s.syncJson(m.roomId, s.alice, { seq: 1 })).result, { winner: 'alice' });
    assert.equal((await s.sendLog(m.roomId, s.alice, log)).status, 204);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('a late-joining winner who tops out after a forfeit still counts', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const created = s.clock.t;
    const m = await s.pair(s.alice, s.bob, 6_000);
    const joined = s.clock.t;
    const { log, topOutStep } = idleThenTopOut(m.seed, 3_800);
    await s.syncJson(m.roomId, s.bob, { seq: 0 });
    await s.syncJson(m.roomId, s.alice, { seq: 0 });
    // forfeit lands 1 s before the winner's top-out on its own clock, 5 s after on the room's
    s.clock.t = joined + topOutStep * 16 - 1_000;
    assert.ok(created + topOutStep * 16 < s.clock.t);
    assert.ok(s.clock.t - created >= 60_000);
    assert.deepEqual((await s.syncJson(m.roomId, s.alice, { seq: 1 })).result, { winner: 'alice' });
    assert.equal((await s.sendLog(m.roomId, s.alice, log)).status, 204);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
  } finally {
    await s.close();
  }
});

test('garbage held back to the end of the log does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { winnerLog: honest(61_000, [[61_000, 1]]) });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('garbage applied within 2 s of delivery still counts', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { winnerLog: honest(61_000, [[2_900, 1]]) });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
  } finally {
    await s.close();
  }
});

test('log timing starts when the winner collected the match', async () => {
  for (const [collectAfterMs, fromCreation, counted] of [
    [1_400, false, true],
    [6_000, false, true],
    [6_000, true, false],
  ] as const) {
    const s = await boot({ maxHeld: 0 });
    try {
      const shift = fromCreation ? collectAfterMs : 0;
      const winnerLog = honest(61_000 + shift, [[1_000 + shift, 1]]);
      const m = await battle(s, { collectAfterMs, winnerLog });
      assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted }, `${collectAfterMs} ${fromCreation}`);
    } finally {
      await s.close();
    }
  }
});

test('a winner log far shorter than the match does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { winnerLog: { steps: 30, inputs: [], garbage: [[30, 1]] } });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('a player cannot queue again while their battle room exists', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await s.pair();
    const busy = await s.queue(s.alice);
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: 'already in a battle' });
    await s.syncJson(m.roomId, s.bob, { seq: 0, isOver: true });
    assert.equal((await s.queue(s.bob)).status, 409);
    assert.equal((await s.queue(s.alice)).status, 409);
    s.clock.t += 60_001;
    assert.deepEqual(await (await s.queue(s.alice)).json(), { status: 'waiting' });
  } finally {
    await s.close();
  }
});

test('an ended room counts toward maxPlayers until it is removed', async () => {
  const s = await boot({ maxPlayers: 2, maxHeld: 0 });
  try {
    const m = await s.pair();
    await s.syncJson(m.roomId, s.bob, { seq: 0, isOver: true });
    const carol = await s.signIn('carol', 3);
    assert.equal((await s.queue(carol)).status, 503);
    s.clock.t += 60_001;
    assert.equal((await s.queue(carol)).status, 200);
  } finally {
    await s.close();
  }
});

test('closing the arena finishes undecided battles once', async () => {
  const s = await boot({ maxHeld: 0 });
  const live = await s.pair(await s.signIn('carol', 3), await s.signIn('dave', 4));
  const waiting = await battle(s, { winnerLog: null });
  s.arena.close();
  s.arena.close();
  assert.deepEqual(s.finished.get(live.roomId), { winner: null, counted: false });
  assert.deepEqual(s.finished.get(waiting.roomId), { winner: null, counted: false });
  await s.close();
  await sleep(300);
  assert.equal(s.finishCalls.get(live.roomId), 1);
  assert.equal(s.finishCalls.get(waiting.roomId), 1);
});

test('closing the arena ends a battle stuck waiting to retry a replay', async () => {
  const replayer: Replayer = { run: async () => ({ ok: false, error: 'busy' }), close: async () => {} };
  const s = await boot({ maxHeld: 0, replayer, timing: { retryMs: 60_000 } });
  const m = await battle(s);
  await sleep(50);
  assert.equal(s.finished.has(m.roomId), false);
  s.arena.close();
  assert.deepEqual(s.finished.get(m.roomId), { winner: null, counted: false });
  await sleep(50);
  await s.close();
  assert.equal(s.finishCalls.get(m.roomId), 1);
});

test('a 45 s match does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const m = await battle(s, { lastsMs: 45_000 });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('a second win for the same pair on the same UTC day does not count', async () => {
  const s = await boot({ maxHeld: 0 });
  try {
    const one = await battle(s);
    assert.deepEqual(await s.waitFinished(one.roomId), { winner: 'alice', counted: true });
    s.clock.t += 60_001;
    const two = await battle(s);
    assert.deepEqual(await s.waitFinished(two.roomId), { winner: 'alice', counted: false });
  } finally {
    await s.close();
  }
});

test('no winner log in time finishes the battle without a winner', async () => {
  const s = await boot({ maxHeld: 0, timing: { winnerLogMs: 200 } });
  try {
    const m = await battle(s, { winnerLog: null });
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: null, counted: false });
    const late = await s.sendLog(m.roomId, s.alice, { steps: 30, inputs: [], garbage: [[1, 1]] });
    assert.equal(late.status, 204);
    await sleep(100);
    assert.deepEqual(s.finished.get(m.roomId), { winner: null, counted: false });
  } finally {
    await s.close();
  }
});

test('a busy replayer is retried and the win still counts', async () => {
  const real = createReplayer({ maxConcurrent: 2, timeoutMs: 10_000, maxQueue: 32 });
  let calls = 0;
  const replayer: Replayer = {
    run: (job) => (++calls === 1 ? Promise.resolve({ ok: false, error: 'busy' }) : real.run(job)),
    close: () => real.close(),
  };
  const s = await boot({ maxHeld: 0, replayer, timing: { retryMs: 50 } });
  try {
    const m = await battle(s);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: true });
    assert.equal(calls, 3);
  } finally {
    await s.close();
  }
});

test('a replayer that stays busy leaves the win uncounted', async () => {
  let calls = 0;
  const replayer: Replayer = {
    run: async () => (calls++, { ok: false, error: 'busy' }),
    close: async () => {},
  };
  const s = await boot({ maxHeld: 0, replayer, timing: { retryMs: 10 } });
  try {
    const m = await battle(s);
    assert.deepEqual(await s.waitFinished(m.roomId), { winner: 'alice', counted: false });
    assert.equal(calls, 4);
  } finally {
    await s.close();
  }
});

test('main serves the battle routes', async () => {
  const gh = (async (url: string | URL | Request) =>
    String(url).includes('/applications/')
      ? new Response('{}')
      : Response.json({ login: 'alice', id: 1, created_at: '2015-01-02T03:04:05Z' })) as typeof globalThis.fetch;
  const s = await start(
    { port: 0, databasePath: ':memory:', githubClientId: 'cid', githubClientSecret: 'cs', maxHeld: 10, maxPlayers: 10, maxConnections: 50, trustProxy: false },
    { fetch: gh, log: () => {} },
  );
  try {
    const call = (path: string, init: RequestInit = {}, token?: string) =>
      fetch(`http://127.0.0.1:${s.port}${path}`, {
        ...init,
        headers: { 'x-protocol-version': '2', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
    const { session } = (await (await call('/v1/session', { method: 'POST', body: '{"githubToken":"t"}' })).json()) as { session: string };
    assert.deepEqual(await (await call('/v1/battle/queue', { method: 'POST' }, session)).json(), { status: 'waiting' });
  } finally {
    await s.close();
  }
});
