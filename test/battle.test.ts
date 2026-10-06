import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, emptyQueue, joinQueue, leaveQueue, newRoom, syncRoom } from '../src/battle.ts';
import type { RoomState } from '../src/battle.ts';
import type { SyncBody } from '../src/protocol.ts';

const make = () => ({ roomId: 'room-1', seed: 42 });

describe('matchmaker', () => {
  test('two players pair; the first learns on its next poll, once', () => {
    const t0 = 1000;
    const a = joinQueue(emptyQueue(), 'ann', t0, make);
    assert.deepEqual(a.result, { status: 'waiting' });
    const b = joinQueue(a.state, 'bob', t0 + 1000, make);
    assert.deepEqual(b.result, { status: 'matched', roomId: 'room-1', seed: 42, opponent: { login: 'ann' } });
    assert.deepEqual(b.room?.players, ['ann', 'bob']);
    const a2 = joinQueue(b.state, 'ann', t0 + 2000, make);
    assert.deepEqual(a2.result, { status: 'matched', roomId: 'room-1', seed: 42, opponent: { login: 'bob' } });
    const a3 = joinQueue(a2.state, 'ann', t0 + 3000, make);
    assert.deepEqual(a3.result, { status: 'waiting' });
  });

  test('an entry expires after 30 s without a poll', () => {
    const a = joinQueue(emptyQueue(), 'ann', 0, make);
    const b = joinQueue(a.state, 'bob', 30_001, make);
    assert.deepEqual(b.result, { status: 'waiting' });
    assert.equal(b.room, undefined);
  });

  test('polling keeps an entry alive and never pairs a player with themselves', () => {
    let q = joinQueue(emptyQueue(), 'ann', 0, make).state;
    q = joinQueue(q, 'ann', 25_000, make).state;
    const again = joinQueue(q, 'ann', 50_000, make);
    assert.deepEqual(again.result, { status: 'waiting' });
    assert.equal(again.state.waiting.length, 1);
    const c = joinQueue(again.state, 'cat', 50_001, make);
    assert.equal(c.result.status, 'matched');
  });

  test('leaving removes the entry', () => {
    const a = joinQueue(emptyQueue(), 'ann', 0, make);
    const q = leaveQueue(a.state, 'ann').state;
    assert.deepEqual(joinQueue(q, 'bob', 1, make).result, { status: 'waiting' });
  });
});

describe('leaving after a match was made', () => {
  const paired = () => joinQueue(joinQueue(emptyQueue(), 'ann', 0, make).state, 'bob', 1, make).state;

  for (const who of ['ann', 'bob']) {
    test(`${who} leaving cancels the room and clears both assignments`, () => {
      const r = leaveQueue(paired(), who);
      assert.deepEqual(r.cancel, ['room-1']);
      assert.deepEqual(r.state.assigned, {});
      assert.deepEqual(joinQueue(r.state, 'ann', 2, make).result, { status: 'waiting' });
    });
  }

  test('leaving after the partner collected the match cancels nothing', () => {
    const q = joinQueue(paired(), 'ann', 2, make).state;
    assert.deepEqual(leaveQueue(q, 'bob').cancel, []);
  });

  test('a stranger leaving cancels nothing', () => {
    const r = leaveQueue(paired(), 'cat');
    assert.deepEqual(r.cancel, []);
    assert.deepEqual(Object.keys(r.state.assigned), ['ann']);
  });
});

describe('room', () => {
  const fresh = (): RoomState => newRoom('room-1', 7, ['ann', 'bob'], 0);
  const msg = (seq: number, attacks: number[] = [], isOver = false): SyncBody => ({ seq, attacks, snapshot: 'S' + seq, isOver });
  const run = (s: RoomState, login: string, m: SyncBody, now: number) => {
    const r = syncRoom(s, login, m, now);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  test('an attack is delivered to the opponent exactly once, by id', () => {
    let s = fresh();
    s = run(s, 'ann', msg(0, [4, 2]), 100).state;
    const first = run(s, 'bob', msg(0), 200);
    assert.deepEqual(first.reply.incoming, [{ id: 1, lines: 4 }, { id: 2, lines: 2 }]);
    const second = run(first.state, 'bob', msg(1), 300);
    assert.deepEqual(second.reply.incoming, []);
  });

  test('a retried sync (same seq) replays the same attacks and does not duplicate them', () => {
    const s = run(fresh(), 'ann', msg(0, [4]), 100).state;
    const a = run(s, 'bob', msg(0), 200);
    const retry = run(a.state, 'bob', msg(0), 250);
    assert.deepEqual(retry.reply.incoming, [{ id: 1, lines: 4 }]);
    const annRetry = run(retry.state, 'ann', msg(0, [4]), 260);
    const b = run(annRetry.state, 'bob', msg(1), 300);
    assert.deepEqual(b.reply.incoming, []);
  });

  test('the reply carries the opponent snapshot', () => {
    const s = run(fresh(), 'ann', msg(0), 100).state;
    assert.deepEqual(run(s, 'bob', msg(0), 150).reply.opponent, { login: 'ann', snapshot: 'S0', isOver: false });
  });

  test('a player who stops polling for over 10 s forfeits', () => {
    let s = run(fresh(), 'ann', msg(0), 1000).state;
    s = run(s, 'bob', msg(0), 1000).state;
    const ok = run(s, 'ann', msg(1), 10_999);
    assert.equal(ok.reply.result, undefined);
    const out = run(ok.state, 'ann', msg(2), 11_001);
    assert.deepEqual(out.reply.result, { winner: 'ann', loser: 'bob', reason: 'forfeit' });
    assert.equal(out.state.resultAt, 11_001);
  });

  test('topping out ends the match for the player who topped out', () => {
    const s = run(fresh(), 'bob', msg(0, [], true), 100);
    assert.deepEqual(s.reply.result, { winner: 'ann', loser: 'bob', reason: 'topout' });
    const other = run(s.state, 'ann', msg(0), 150);
    assert.equal(other.reply.result?.winner, 'ann');
  });

  test('the result is final and later attacks are ignored', () => {
    const s = run(fresh(), 'bob', msg(0, [], true), 100).state;
    const after = run(s, 'ann', msg(0, [4]), 150).state;
    assert.deepEqual(after.players[1].inbox, []);
    assert.equal(after.result?.winner, 'ann');
  });

  test('attacks beyond the match-time budget are dropped, not rejected', () => {
    // budget at 1 s: 15 burst + 2.5 = 17.5 lines; written out by hand, not read from the source
    const flood = run(fresh(), 'ann', msg(0, Array(20).fill(40)), 1000).state;
    assert.deepEqual(flood.players[1].inbox, []);
    const some = run(fresh(), 'ann', msg(0, [10, 10, 4]), 1000).state;
    assert.deepEqual(some.players[1].inbox, [{ id: 1, lines: 10 }, { id: 2, lines: 4 }]);
    assert.equal(some.players[0].sent, 14);
    // 8 s in: 15 + 20 = 35 lines allowed in total; 30 sent, then 4 fits (34) and the next 4 does not (38)
    let s = run(fresh(), 'ann', msg(0, [10, 10, 10]), 8000).state;
    s = run(s, 'ann', msg(1, [4, 4]), 8000).state;
    assert.deepEqual(s.players[1].inbox.map((a) => a.lines), [10, 10, 10, 4]);
  });

  test('the budget grows with elapsed time', () => {
    // 15 burst at t=0; 25 allowed at 4 s (15 + 2.5 * 4); 30 allowed at 6 s
    let s = run(fresh(), 'ann', msg(0, [15]), 0).state;
    s = run(s, 'ann', msg(1, [15, 10]), 4000).state;
    assert.deepEqual(s.players[1].inbox.map((a) => a.lines), [15, 10]);
    s = run(s, 'ann', msg(2, [6]), 4000).state;
    assert.deepEqual(s.players[1].inbox.map((a) => a.lines), [15, 10]);
    s = run(s, 'ann', msg(3, [5]), 6000).state;
    assert.deepEqual(s.players[1].inbox.map((a) => a.lines), [15, 10, 5]);
  });

  test('strangers are refused', () => {
    assert.equal(syncRoom(fresh(), 'eve', msg(0), 1).ok, false);
  });

  test('collect hands over attacks that arrived after the sync and redelivers them on a retry', () => {
    let s = run(fresh(), 'bob', msg(0), 100).state;
    s = run(s, 'ann', msg(0, [3]), 200).state;
    const c = collect(s, 'bob', 300);
    assert.deepEqual(c.reply.incoming, [{ id: 1, lines: 3 }]);
    assert.deepEqual(c.state.players[1].inbox, []);
    assert.equal(c.state.players[1].lastPoll, 300);
    assert.deepEqual(run(c.state, 'bob', msg(0), 400).reply.incoming, [{ id: 1, lines: 3 }]);
    assert.deepEqual(run(c.state, 'bob', msg(1), 400).reply.incoming, []);
  });
});
