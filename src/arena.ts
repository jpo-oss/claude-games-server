import { randomBytes, randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { Reply } from './http.ts';
import { STEP_MS } from './replay.ts';
import type { ReplayJob, ReplayResult } from './replay.ts';
import { collect, emptyQueue, joinQueue, leaveQueue, liveQueue, newRoom, syncRoom } from './battle.ts';
import type { RoomReply, RoomState } from './battle.ts';
import type { GameLog, SyncBody, SyncReply } from './protocol.ts';

export type ArenaTiming = { holdMs?: number; winnerLogMs?: number; retryMs?: number; sweepMs?: number };

const HOLD_MS = 2_000;
const HOLD_LIMIT_MS = 25_000;
const WINNER_LOG_MS = 30_000;
const RETRY_MS = 5_000;
const RETRIES = 3;
const SWEEP_MS = 5_000;
const KEEP_MS = 60_000;
const MIN_MATCH_MS = 60_000;
const GARBAGE_SLACK_STEPS = 125;
const LENGTH_SLACK_MS = 5_000;
const RETRYABLE = new Set(['busy', 'timeout', 'closed', 'replay failed']);

type Held = { answer: (body: SyncReply) => void };
type Live = {
  state: RoomState;
  delivered: Map<string, Map<number, number>>;
  deliveredAt: Map<number, number>;
  joinedAt: Map<string, number>;
  seen: Map<string, string>;
  held: Map<string, Held>;
  logs: Map<string, GameLog>;
  logTimer?: NodeJS.Timeout;
  verifying: boolean;
  finished: boolean;
};

const view = (p: { snapshot: string; isOver: boolean }) => `${p.isOver ? 1 : 0}${p.snapshot}`;

export function createArena(deps: {
  db: Pick<Db, 'recordBattle' | 'finishBattle' | 'countedToday'>;
  replayer: { run(job: ReplayJob): Promise<ReplayResult> };
  maxPlayers: number;
  maxHeld: number;
  now?: () => number;
  timing?: ArenaTiming;
}) {
  const { db, replayer, maxPlayers, maxHeld } = deps;
  const now = deps.now ?? Date.now;
  const holdMs = Math.min(deps.timing?.holdMs ?? HOLD_MS, HOLD_LIMIT_MS);
  const winnerLogMs = deps.timing?.winnerLogMs ?? WINNER_LOG_MS;
  const retryMs = deps.timing?.retryMs ?? RETRY_MS;
  const rooms = new Map<string, Live>();
  const roomOf = new Map<string, string>();
  const undecided = new Set<Live>();
  const waits = new Set<() => void>();
  const timers = new Set<NodeJS.Timeout>();
  let queue = emptyQueue();
  let heldCount = 0;
  let closed = false;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: NodeJS.Timeout | undefined) => {
    if (!t) return;
    clearTimeout(t);
    timers.delete(t);
  };
  const sweeper = setInterval(sweep, deps.timing?.sweepMs ?? SWEEP_MS);
  sweeper.unref();

  const other = (live: Live, login: string) => live.state.players.find((p) => p.login !== login)!;
  const self = (live: Live, login: string) => live.state.players.find((p) => p.login === login)!;

  function toReply(live: Live, login: string, r: RoomReply): SyncReply {
    const got = live.delivered.get(login)!;
    // a client stops at the result, so attacks it has not seen before then are never delivered
    const incoming = r.result ? r.incoming.filter((a) => got.has(a.id)) : r.incoming;
    for (const a of incoming) {
      got.set(a.id, a.lines);
      if (!live.deliveredAt.has(a.id)) live.deliveredAt.set(a.id, now());
    }
    live.seen.set(login, view(r.opponent));
    return {
      opponent: r.opponent,
      incoming,
      ...(r.result ? { result: { winner: r.result.winner } } : {}),
    };
  }

  const hasNews = (live: Live, login: string) =>
    live.state.result !== null || self(live, login).inbox.length > 0 || live.seen.get(login) !== view(other(live, login));

  function answer(live: Live, login: string) {
    const h = live.held.get(login);
    if (!h) return;
    const c = collect(live.state, login, now());
    live.state = c.state;
    h.answer(toReply(live, login, c.reply));
  }

  function finish(live: Live, winner: string | null, counted: boolean) {
    if (live.finished || closed) return;
    live.finished = true;
    undecided.delete(live);
    cancel(live.logTimer);
    db.finishBattle(live.state.roomId, winner, counted, now());
  }

  function remove(live: Live) {
    for (const login of [...live.held.keys()]) answer(live, login);
    rooms.delete(live.state.roomId);
    for (const p of live.state.players) if (roomOf.get(p.login) === live.state.roomId) roomOf.delete(p.login);
  }

  function sweep() {
    const t = now();
    for (const live of rooms.values()) {
      const { result, resultAt, players } = live.state;
      if (result) {
        if (t - resultAt! > KEEP_MS) remove(live);
      } else if (t - Math.max(players[0].lastPoll, players[1].lastPoll) > KEEP_MS) {
        finish(live, null, false);
        remove(live);
      }
    }
  }

  async function run(job: ReplayJob): Promise<ReplayResult> {
    for (let i = 0; ; i++) {
      const r = await replayer.run(job);
      if (r.ok || !RETRYABLE.has(r.error) || i === RETRIES || closed) return r;
      await new Promise<void>((resolve) => {
        const done = () => {
          waits.delete(done);
          resolve();
        };
        waits.add(done);
        later(retryMs, done);
      });
    }
  }

  async function verify(live: Live) {
    const { seed, startedAt, resultAt, players } = live.state;
    const { winner, loser, reason } = live.state.result!;
    const winnerLog = live.logs.get(winner)!;
    const got = live.delivered.get(winner)!;
    const joinedAt = live.joinedAt.get(winner) ?? startedAt;
    const garbage = winnerLog.garbage ?? [];
    const ids = garbage.map(([, id]) => id);
    const onTime = garbage.every(
      ([s, id]) => Math.abs(s - Math.round((live.deliveredAt.get(id)! - joinedAt) / STEP_MS)) <= GARBAGE_SLACK_STEPS,
    );
    let counted =
      ids.length === got.size &&
      new Set(ids).size === ids.length &&
      ids.every((id) => got.has(id)) &&
      onTime &&
      Math.abs(winnerLog.steps * STEP_MS - (resultAt! - joinedAt)) <= LENGTH_SLACK_MS &&
      resultAt! - startedAt >= MIN_MATCH_MS;
    if (counted) {
      const w = await run({ seed, mode: 'battle', log: winnerLog, garbage: got });
      const sent = players.find((p) => p.login === winner)!.sent;
      counted =
        w.ok &&
        w.attacks.reduce((a, b) => a + b, 0) >= sent &&
        (!w.isOver || (reason === 'forfeit' && startedAt + w.topOutStep! * STEP_MS >= resultAt!));
    }
    const loserLog = live.logs.get(loser);
    if (counted && loserLog) {
      const l = await run({ seed, mode: 'battle', log: loserLog, garbage: live.delivered.get(loser)! });
      counted = l.ok && l.isOver;
    }
    finish(live, winner, counted && !db.countedToday(winner, loser, now()));
  }

  return {
    sweep,

    join(login: string): Reply {
      sweep();
      const t = now();
      const q = liveQueue(queue, t);
      const current = roomOf.get(login);
      if (current && rooms.has(current) && !(login in q.assigned)) {
        return { status: 409, body: { error: 'already in a battle' } };
      }
      const known = q.waiting.some((w) => w.login === login) || login in q.assigned;
      if (!known && q.waiting.length + rooms.size * 2 + 1 > maxPlayers) {
        return { status: 503, body: { error: 'server busy' } };
      }
      const out = joinQueue(q, login, t, () => ({ roomId: randomBytes(16).toString('base64url'), seed: randomInt(0, 2 ** 32) }));
      if (out.room) {
        const { roomId, seed, players } = out.room;
        db.recordBattle(roomId, players[0], players[1], seed, t);
        const live: Live = {
          state: newRoom(roomId, seed, players, t),
          delivered: new Map(players.map((p) => [p, new Map()])),
          deliveredAt: new Map(),
          joinedAt: new Map(),
          seen: new Map(players.map((p) => [p, view({ snapshot: '', isOver: false })])),
          held: new Map(),
          logs: new Map(),
          verifying: false,
          finished: false,
        };
        rooms.set(roomId, live);
        undecided.add(live);
        for (const p of players) roomOf.set(p, roomId);
      }
      queue = out.state;
      if (out.result.status === 'matched') rooms.get(out.result.roomId)?.joinedAt.set(login, t);
      return { status: 200, body: out.result };
    },

    leave(login: string): Reply {
      const out = leaveQueue(liveQueue(queue, now()), login);
      queue = out.state;
      for (const id of out.cancel) {
        const live = rooms.get(id);
        if (!live) continue;
        finish(live, null, false);
        remove(live);
      }
      return { status: 204 };
    },

    sync(roomId: string, login: string, body: SyncBody, signal: AbortSignal): Promise<Reply> {
      const live = rooms.get(roomId);
      if (!live) return Promise.resolve({ status: 404, body: { error: 'no such room' } });
      answer(live, login);
      const r = syncRoom(live.state, login, body, now());
      if (!r.ok) return Promise.resolve({ status: r.status, body: { error: r.error } });
      const hadResult = live.state.result !== null;
      live.state = r.state;
      const result = r.state.result;
      if (!hadResult && result) {
        live.logTimer = later(winnerLogMs, () => {
          if (!live.verifying) finish(live, null, false);
        });
      }
      const opp = other(live, login).login;
      if (live.held.has(opp) && hasNews(live, opp)) answer(live, opp);

      if (r.reply.incoming.length > 0 || hasNews(live, login) || heldCount >= maxHeld || signal.aborted || closed) {
        return Promise.resolve({ status: 200, body: toReply(live, login, r.reply) });
      }
      return new Promise((resolve) => {
        const release = () => {
          live.held.delete(login);
          heldCount--;
          cancel(timer);
          signal.removeEventListener('abort', drop);
        };
        const drop = () => {
          release();
          resolve({ status: 204 });
        };
        const timer = later(holdMs, () => answer(live, login));
        signal.addEventListener('abort', drop, { once: true });
        live.held.set(login, {
          answer: (b) => {
            release();
            resolve({ status: 200, body: b });
          },
        });
        heldCount++;
      });
    },

    log(roomId: string, login: string, log: GameLog): Reply {
      const live = rooms.get(roomId);
      if (!live) return { status: 404, body: { error: 'no such room' } };
      if (!live.state.players.some((p) => p.login === login)) return { status: 403, body: { error: 'not in this room' } };
      const result = live.state.result;
      if (!result) return { status: 409, body: { error: 'battle not over' } };
      if (live.logs.has(login)) return { status: 409, body: { error: 'already sent' } };
      live.logs.set(login, log);
      if (login === result.winner && !live.finished && !live.verifying) {
        live.verifying = true;
        cancel(live.logTimer);
        verify(live).catch(() => finish(live, result.winner, false));
      }
      return { status: 204 };
    },

    close() {
      if (closed) return;
      for (const live of rooms.values()) for (const login of [...live.held.keys()]) answer(live, login);
      for (const live of [...undecided]) finish(live, null, false);
      closed = true;
      for (const done of [...waits]) done();
      clearInterval(sweeper);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

export type Arena = ReturnType<typeof createArena>;
