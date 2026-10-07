import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';

const D = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 9, 7, 12);
const OLD = T0 - 30 * D;
const WORDS = ['qqqqa', 'qqqqb', 'qqqqc', 'qqqqd', 'qqqqe'];
const first = () => 0;
const setup = () => {
  const db = openDb(':memory:');
  for (const [i, login] of ['alice', 'bob', 'carol'].entries()) db.upsertPlayer({ login, githubId: i + 1, githubCreatedAt: 0 }, T0);
  db.upsertPlayer({ login: 'newbie', githubId: 9, githubCreatedAt: T0 }, T0);
  return db;
};
type Dd = ReturnType<typeof setup>['dailyDiff'];
function play(dd: Dd, login: string, day: string, n: number, solved: boolean, ms: number) {
  dd.ensurePuzzle(day, WORDS, first);
  const start = Date.parse(`${day}T01:00:00Z`);
  dd.startGame(login, day, start);
  for (let i = 1; i < n; i++) dd.saveGuesses(login, day, Array(i).fill('zzzza'), null);
  dd.saveGuesses(login, day, Array(n).fill('zzzza'), { at: start + ms, solved });
}

test('a day gets one puzzle; a second call sees the same row; numbers count up', () => {
  const dd = setup().dailyDiff;
  const a = dd.ensurePuzzle('2026-10-07', WORDS, first);
  assert.deepEqual(dd.ensurePuzzle('2026-10-07', WORDS, () => 3), a);
  assert.equal(a.number, 1);
  assert.equal(dd.ensurePuzzle('2026-10-08', WORDS, first).number, 2);
});

test('answers do not repeat until all are used, then the least recently used returns', () => {
  const dd = setup().dailyDiff;
  const three = WORDS.slice(0, 3);
  const got = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((d) => dd.ensurePuzzle(d, three, first).word);
  assert.equal(new Set(got.slice(0, 3)).size, 3);
  assert.equal(got[3], got[0]);
});

test('one game per player per day; saves need the previous guess count and an open game', () => {
  const dd = setup().dailyDiff;
  dd.ensurePuzzle('2026-10-07', WORDS, first);
  const g = dd.startGame('alice', '2026-10-07', T0);
  assert.deepEqual(dd.startGame('alice', '2026-10-07', T0 + 5000), g);
  assert.equal(dd.saveGuesses('alice', '2026-10-07', ['zzzza'], null), true);
  assert.equal(dd.saveGuesses('alice', '2026-10-07', ['zzzza'], null), false);
  assert.equal(dd.saveGuesses('alice', '2026-10-07', ['zzzza', 'qqqqa'], { at: T0 + 60_000, solved: true }), true);
  assert.equal(dd.saveGuesses('alice', '2026-10-07', ['zzzza', 'qqqqa', 'zzzzb'], null), false);
  assert.deepEqual(dd.getGame('alice', '2026-10-07')!.guesses, ['zzzza', 'qqqqa']);
});

test('games left open past their day close as failed at the end of that day', () => {
  const dd = setup().dailyDiff;
  dd.ensurePuzzle('2026-10-07', WORDS, first);
  dd.startGame('bob', '2026-10-07', T0);
  dd.closeStale('2026-10-08');
  const g = dd.getGame('bob', '2026-10-07')!;
  assert.deepEqual([g.solved, g.finishedAt], [false, Date.UTC(2026, 9, 8)]);
});

test('today ranks solvers by guesses then time; fails last; young accounts hidden', () => {
  const dd = setup().dailyDiff;
  play(dd, 'alice', '2026-10-07', 4, true, 9000);
  play(dd, 'bob', '2026-10-07', 3, true, 50000);
  play(dd, 'carol', '2026-10-07', 6, false, 1000);
  play(dd, 'newbie', '2026-10-07', 1, true, 10);
  const b = dd.board('today', '2026-10-07', '2026-10-07', OLD, 'carol');
  assert.deepEqual(b.rows.map((r) => [r.rank, r.login, r.guesses]), [[1, 'bob', 3], [2, 'alice', 4], [3, 'carol', null]]);
  assert.equal(b.you, null);
});

test('period boards sum points, tie-break on total time, and respect the window', () => {
  const dd = setup().dailyDiff;
  play(dd, 'alice', '2026-10-04', 1, true, 1000);
  play(dd, 'alice', '2026-10-05', 3, true, 5000);
  play(dd, 'bob', '2026-10-05', 2, true, 9000);
  play(dd, 'alice', '2026-10-06', 6, true, 1000);
  const week = dd.board('week', '2026-10-07', '2026-10-05', OLD, 'alice');
  assert.deepEqual(week.rows.map((r) => [r.login, r.points, r.played, r.ms]), [['alice', 5, 2, 6000], ['bob', 5, 1, 9000]]);
  assert.equal(dd.board('all', '2026-10-07', '0000-01-01', OLD, 'alice').rows[0]!.points, 11);
});

test('20 rows, then your own rank below them', () => {
  const db = setup();
  for (let i = 0; i < 25; i++) db.upsertPlayer({ login: `p${i}`, githubId: 100 + i, githubCreatedAt: 0 }, T0);
  for (let i = 0; i < 25; i++) play(db.dailyDiff, `p${i}`, '2026-10-07', 2, true, 1000 + i);
  const b = db.dailyDiff.board('today', '2026-10-07', '2026-10-07', OLD, 'p24');
  assert.equal(b.rows.length, 20);
  assert.deepEqual([b.you?.rank, b.you?.login], [25, 'p24']);
});

test('stats: distribution and streaks broken by a fail or a missed day', () => {
  const dd = setup().dailyDiff;
  play(dd, 'alice', '2026-10-01', 2, true, 1);
  play(dd, 'alice', '2026-10-02', 3, true, 1);
  play(dd, 'alice', '2026-10-03', 3, true, 1);
  play(dd, 'alice', '2026-10-04', 6, false, 1);
  play(dd, 'alice', '2026-10-06', 4, true, 1);
  assert.deepEqual(dd.stats('alice', '2026-10-07'), { played: 5, won: 4, streak: 1, bestStreak: 3, distribution: [0, 1, 2, 1, 0, 0] });
  assert.equal(dd.stats('alice', '2026-10-08').streak, 0);
});
