import type { QueueStatus, SyncBody } from './protocol.ts';

export const QUEUE_TTL_MS = 30_000;
export const ASSIGN_TTL_MS = 30_000;
export const FORFEIT_MS = 10_000;
// Attack budget: burst 15 plus 2.5 lines/s since the room was made. Elite play (about 150 attacks
// per minute, with 4-line and back-to-back clears) tops out near 2.5 lines/s, so a human stays
// under it while a client that fakes 20 x 40 lines per request is cut to the cap.
export const ATTACK_BURST = 15;
export const ATTACK_PER_SEC = 2.5;

export type Fail = { ok: false; status: number; error: string };

export type Waiting = { login: string; at: number };
export type Assignment = { roomId: string; seed: number; opponent: string; at: number };
export type QueueState = { waiting: Waiting[]; assigned: Record<string, Assignment> };
export const emptyQueue = (): QueueState => ({ waiting: [], assigned: {} });

export type NewRoom = { roomId: string; seed: number; players: [string, string] };

export function liveQueue(s: QueueState, now: number): QueueState {
  return {
    waiting: s.waiting.filter((w) => now - w.at <= QUEUE_TTL_MS),
    assigned: Object.fromEntries(Object.entries(s.assigned).filter(([, a]) => now - a.at <= ASSIGN_TTL_MS)),
  };
}

export function joinQueue(
  s: QueueState,
  me: string,
  now: number,
  make: () => { roomId: string; seed: number },
): { state: QueueState; result: QueueStatus; room?: NewRoom } {
  const { waiting, assigned } = liveQueue(s, now);

  const mine = assigned[me];
  if (mine) {
    delete assigned[me];
    const { roomId, seed, opponent } = mine;
    return { state: { waiting, assigned }, result: { status: 'matched', roomId, seed, opponent: { login: opponent } } };
  }

  const self = waiting.findIndex((w) => w.login === me);
  if (self >= 0) {
    waiting[self] = { login: me, at: now };
    return { state: { waiting, assigned }, result: { status: 'waiting' } };
  }

  const other = waiting.shift();
  if (!other) {
    waiting.push({ login: me, at: now });
    return { state: { waiting, assigned }, result: { status: 'waiting' } };
  }
  const { roomId, seed } = make();
  assigned[other.login] = { roomId, seed, opponent: me, at: now };
  return {
    state: { waiting, assigned },
    result: { status: 'matched', roomId, seed, opponent: { login: other.login } },
    room: { roomId, seed, players: [other.login, me] },
  };
}

// A room made for a pair that has not both collected it yet is cancelled when either leaves.
export function leaveQueue(s: QueueState, login: string): { state: QueueState; cancel: string[] } {
  const assigned: Record<string, Assignment> = {};
  const cancel: string[] = [];
  for (const [who, a] of Object.entries(s.assigned)) {
    if (who === login || a.opponent === login) cancel.push(a.roomId);
    else assigned[who] = a;
  }
  return { state: { waiting: s.waiting.filter((w) => w.login !== login), assigned }, cancel };
}

export type Attack = { id: number; lines: number };
export type RoomPlayer = {
  login: string;
  lastPoll: number;
  lastSeq: number;
  snapshot: string;
  isOver: boolean;
  inbox: Attack[];
  lastIncoming: Attack[];
  sent: number;
};
export type RoomResult = { winner: string; loser: string; reason: 'topout' | 'forfeit' };
export type RoomState = {
  roomId: string;
  seed: number;
  players: [RoomPlayer, RoomPlayer];
  nextId: number;
  result: RoomResult | null;
  startedAt: number;
  resultAt: number | null;
};
export type RoomReply = {
  opponent: { login: string; snapshot: string; isOver: boolean };
  incoming: Attack[];
  result?: RoomResult;
};

export function newRoom(roomId: string, seed: number, logins: [string, string], now: number): RoomState {
  const p = (login: string): RoomPlayer => ({
    login, lastPoll: now, lastSeq: -1, snapshot: '', isOver: false, inbox: [], lastIncoming: [], sent: 0,
  });
  return { roomId, seed, players: [p(logins[0]), p(logins[1])], nextId: 1, result: null, startedAt: now, resultAt: null };
}

const view = (s: RoomState, opp: RoomPlayer, incoming: Attack[]): RoomReply => ({
  opponent: { login: opp.login, snapshot: opp.snapshot, isOver: opp.isOver },
  incoming,
  ...(s.result ? { result: s.result } : {}),
});

export function syncRoom(
  s: RoomState,
  login: string,
  input: SyncBody,
  now: number,
): { ok: true; state: RoomState; reply: RoomReply } | Fail {
  const mi = s.players.findIndex((p) => p.login === login);
  if (mi < 0) return { ok: false, status: 403, error: 'not in this room' };
  const players = [{ ...s.players[0] }, { ...s.players[1] }] as [RoomPlayer, RoomPlayer];
  const me = players[mi]!;
  const opp = players[1 - mi]!;
  let { nextId, result, resultAt } = s;
  me.lastPoll = now;

  let incoming: Attack[] = [];
  if (input.seq > me.lastSeq) {
    me.lastSeq = input.seq;
    me.snapshot = input.snapshot;
    me.isOver = input.isOver;
    incoming = me.inbox;
    me.inbox = [];
    me.lastIncoming = incoming;
    if (!result) {
      opp.inbox = [...opp.inbox];
      const budget = ATTACK_BURST + (ATTACK_PER_SEC * (now - s.startedAt)) / 1000;
      for (const lines of input.attacks) {
        if (me.sent + lines > budget) continue;
        me.sent += lines;
        opp.inbox.push({ id: nextId++, lines });
      }
      if (input.isOver) {
        result = { winner: opp.login, loser: me.login, reason: 'topout' };
        resultAt = now;
      }
    }
  } else if (input.seq === me.lastSeq) {
    incoming = me.lastIncoming;
  }

  if (!result && now - opp.lastPoll > FORFEIT_MS) {
    result = { winner: me.login, loser: opp.login, reason: 'forfeit' };
    resultAt = now;
  }

  const state: RoomState = { ...s, players, nextId, result, resultAt };
  return { ok: true, state, reply: view(state, opp, incoming) };
}

// Answers a held sync: attacks that reached the inbox while it waited go out with it.
export function collect(s: RoomState, login: string, now: number): { state: RoomState; reply: RoomReply } {
  const mi = s.players.findIndex((p) => p.login === login);
  const players = [{ ...s.players[0] }, { ...s.players[1] }] as [RoomPlayer, RoomPlayer];
  const me = players[mi]!;
  me.lastPoll = now;
  const incoming = [...me.lastIncoming, ...me.inbox];
  me.lastIncoming = incoming;
  me.inbox = [];
  const state: RoomState = { ...s, players };
  return { state, reply: view(state, players[1 - mi]!, incoming) };
}
