import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/db.ts';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 6, 12);
const OLD = NOW - 90 * DAY;

let nextId = 1;
function player(db: Db, login: string, githubCreatedAt = OLD) {
  db.upsertPlayer({ login, githubId: nextId++, githubCreatedAt }, NOW);
}

function score(db: Db, login: string, s: number, at: number) {
  const id = db.startMarathon(login, 1, at - 1000);
  db.finishMarathon(id, { score: s, lines: s / 10, level: 2 }, at);
}

function win(db: Db, room: string, a: string, b: string, winner: string, at: number, counted = true) {
  db.recordBattle(room, a, b, 1, at - 1000);
  db.finishBattle(room, winner, counted, at);
}

test('session create, find, delete', () => {
  const db = openDb(':memory:');
  player(db, 'ann');
  const key = db.createSession('ann', NOW);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.findSession(key, NOW + 1000), 'ann');
  assert.equal(db.findSession('nope', NOW), null);
  db.deleteSession(key);
  assert.equal(db.findSession(key, NOW + 2000), null);
});

test('session idle expiry at exactly 30 days + 1 ms, and use refreshes it', () => {
  const db = openDb(':memory:');
  player(db, 'ann');
  const a = db.createSession('ann', NOW);
  assert.equal(db.findSession(a, NOW + 30 * DAY), 'ann');
  assert.equal(db.findSession(a, NOW + 30 * DAY + 30 * DAY), 'ann');
  const b = db.createSession('ann', NOW);
  assert.equal(db.findSession(b, NOW + 30 * DAY + 1), null);
  assert.equal(db.findSession(b, NOW), null);
});

test('marathon start, finish and rejection', () => {
  const db = openDb(':memory:');
  player(db, 'ann');
  const id = db.startMarathon('ann', 42, NOW);
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  const g = db.getMarathon(id);
  assert.equal(g?.login, 'ann');
  assert.equal(g?.seed, 42);
  assert.equal(g?.finishedAt, null);
  db.finishMarathon(id, { score: 100, lines: 3, level: 1 }, NOW + 5);
  const f = db.getMarathon(id);
  assert.equal(f?.finishedAt, NOW + 5);
  assert.equal(f?.score, 100);
  assert.equal(db.getMarathon('missing'), null);
});

test('leaderboard keeps best score only', () => {
  const db = openDb(':memory:');
  player(db, 'ann');
  score(db, 'ann', 100, NOW - 3000);
  score(db, 'ann', 500, NOW - 2000);
  score(db, 'ann', 300, NOW - 1000);
  assert.deepEqual(db.leaderboard(NOW).marathon, [{ login: 'ann', score: 500, lines: 50, level: 2, at: NOW - 2000 }]);
});

test('rejected games do not count', () => {
  const db = openDb(':memory:');
  player(db, 'ann');
  const id = db.startMarathon('ann', 1, NOW - 100);
  db.finishMarathon(id, null, NOW - 50);
  const g = db.getMarathon(id);
  assert.equal(g?.finishedAt, NOW - 50);
  assert.equal(g?.score, null);
  db.startMarathon('ann', 1, NOW - 10);
  assert.deepEqual(db.leaderboard(NOW).marathon, []);
});

test('accounts younger than 30 days are hidden on both boards', () => {
  const db = openDb(':memory:');
  player(db, 'old', NOW - 30 * DAY);
  player(db, 'new', NOW - 30 * DAY + 1);
  score(db, 'old', 10, NOW - 10);
  score(db, 'new', 999, NOW - 10);
  win(db, 'r1', 'old', 'new', 'old', NOW - 5);
  win(db, 'r2', 'old', 'new', 'new', NOW - 4);
  const lb = db.leaderboard(NOW);
  assert.deepEqual(lb.marathon.map((r) => r.login), ['old']);
  assert.deepEqual(lb.wins, [{ login: 'old', wins: 1 }]);
});

test('top 5 cut, score desc then earlier first, wins desc then login asc', () => {
  const db = openDb(':memory:');
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  for (const n of names) player(db, n);
  score(db, 'a', 100, NOW - 100);
  score(db, 'b', 200, NOW - 90);
  score(db, 'c', 200, NOW - 95);
  score(db, 'd', 50, NOW - 80);
  score(db, 'e', 60, NOW - 70);
  score(db, 'f', 70, NOW - 60);
  score(db, 'g', 10, NOW - 50);
  const lb = db.leaderboard(NOW);
  assert.deepEqual(lb.marathon.map((r) => r.login), ['c', 'b', 'a', 'f', 'e']);

  let i = 0;
  const w = (who: string, n: number, counted = true) => {
    for (let k = 0; k < n; k++) win(db, `r${i++}`, who, 'g', who, NOW - 10, counted);
  };
  w('f', 3); w('b', 2); w('a', 2); w('c', 1); w('d', 1); w('e', 1); w('g', 9, false);
  assert.deepEqual(db.leaderboard(NOW).wins, [
    { login: 'f', wins: 3 },
    { login: 'a', wins: 2 },
    { login: 'b', wins: 2 },
    { login: 'c', wins: 1 },
    { login: 'd', wins: 1 },
  ]);
});

test('renamed login keeps scores, wins and sessions', () => {
  const db = openDb(':memory:');
  db.upsertPlayer({ login: 'ann', githubId: 7, githubCreatedAt: OLD }, NOW);
  db.upsertPlayer({ login: 'bob', githubId: 8, githubCreatedAt: OLD }, NOW);
  const key = db.createSession('ann', NOW);
  score(db, 'ann', 500, NOW - 100);
  win(db, 'r1', 'ann', 'bob', 'ann', NOW - 50);
  db.upsertPlayer({ login: 'annie', githubId: 7, githubCreatedAt: OLD }, NOW + 1);
  assert.equal(db.findSession(key, NOW + 2), 'annie');
  const lb = db.leaderboard(NOW + 2);
  assert.deepEqual(lb.marathon.map((r) => [r.login, r.score]), [['annie', 500]]);
  assert.deepEqual(lb.wins, [{ login: 'annie', wins: 1 }]);
});

test('once-per-day pair check across UTC midnight', () => {
  const db = openDb(':memory:');
  player(db, 'ann');
  player(db, 'bob');
  player(db, 'cat');
  const lateNight = Date.UTC(2026, 9, 6, 23, 59, 0);
  win(db, 'r1', 'ann', 'bob', 'ann', lateNight);
  db.recordBattle('r2', 'ann', 'cat', 1, lateNight);
  db.finishBattle('r2', 'ann', false, lateNight);
  assert.equal(db.countedToday('ann', 'bob', lateNight + 30_000), true);
  assert.equal(db.countedToday('bob', 'ann', lateNight + 30_000), true);
  assert.equal(db.countedToday('ann', 'cat', lateNight + 30_000), false);
  assert.equal(db.countedToday('ann', 'bob', Date.UTC(2026, 9, 7, 0, 0, 0)), false);
  assert.equal(db.countedToday('ann', 'bob', Date.UTC(2026, 9, 7, 0, 1, 0)), false);
});

test('a login taken over by another account keeps every returned login valid', () => {
  const db = openDb(':memory:');
  const valid = /^[A-Za-z0-9-]{1,39}$/;
  db.upsertPlayer({ login: 'ann', githubId: 7, githubCreatedAt: OLD }, NOW);
  db.upsertPlayer({ login: 'bob', githubId: 8, githubCreatedAt: OLD }, NOW);
  const oldKey = db.createSession('ann', NOW);
  score(db, 'ann', 500, NOW - 100);
  win(db, 'r1', 'ann', 'bob', 'ann', NOW - 50);

  db.upsertPlayer({ login: 'ann', githubId: 9, githubCreatedAt: OLD }, NOW + 1);
  const newKey = db.createSession('ann', NOW + 1);
  score(db, 'ann', 40, NOW + 2);

  assert.equal(db.findSession(oldKey, NOW + 3), null);
  assert.equal(db.findSession(newKey, NOW + 3), 'ann');
  let lb = db.leaderboard(NOW + 3);
  const logins = [...lb.marathon.map((r) => r.login), ...lb.wins.map((r) => r.login), db.findSession(newKey, NOW + 3)];
  for (const l of logins) assert.match(l as string, valid);
  assert.deepEqual(lb.marathon.map((r) => [r.login, r.score]), [['ann', 40]]);
  assert.deepEqual(lb.wins, []);

  db.upsertPlayer({ login: 'ann-two', githubId: 7, githubCreatedAt: OLD }, NOW + 4);
  lb = db.leaderboard(NOW + 5);
  assert.deepEqual(lb.marathon.map((r) => [r.login, r.score]), [['ann-two', 500], ['ann', 40]]);
  assert.deepEqual(lb.wins, [{ login: 'ann-two', wins: 1 }]);
});
