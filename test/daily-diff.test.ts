import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/main.ts';
import { wordDir } from './words.ts';

const cfg = { port: 0, databasePath: ':memory:', githubClientId: 'cid', githubClientSecret: 'csecret', maxHeld: 10, maxPlayers: 10, maxConnections: 50, trustProxy: false };

async function boot(o: { now?: number; words?: boolean } = {}) {
  let now = o.now ?? Date.UTC(2026, 9, 7, 12);
  const gh = (async (url: string | URL | Request) =>
    String(url).includes('/applications/')
      ? new Response('{}')
      : Response.json({ login: 'alice', id: 7, created_at: '2015-01-02T03:04:05Z' })) as typeof globalThis.fetch;
  const s = await start(
    { ...cfg, dailyDiffWordsDir: o.words === false ? undefined : wordDir('qqqqa\n', 'zzzza\nzzzzb\n') },
    { fetch: gh, log: () => {}, now: () => now },
  );
  const call = (path: string, init: RequestInit = {}, token?: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${s.port}${path}`, {
      ...init,
      headers: { 'x-protocol-version': '3', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  const session = ((await (await call('/v1/session', { method: 'POST', body: '{"githubToken":"t"}' })).json()) as { session: string }).session;
  const dd = (path: string, body?: unknown) =>
    call(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }, session, { 'x-game': 'daily-diff', 'x-protocol-version': '1' });
  return { ...s, call, session, dd, setNow: (n: number) => (now = n) };
}

test('today starts a game; guesses get marks; the answer shows only at the end', async () => {
  const s = await boot();
  try {
    const t = await (await s.dd('/v1/daily-diff/today')).json();
    assert.deepEqual([t.number, t.state, t.guesses, t.answer], [1, 'playing', [], null]);
    const g1 = await (await s.dd('/v1/daily-diff/guess', { number: 1, word: 'zzzza' })).json();
    assert.deepEqual([g1.guesses, g1.answer], [[{ word: 'zzzza', marks: 'xxxxg' }], null]);
    const g2 = await (await s.dd('/v1/daily-diff/guess', { number: 1, word: 'qqqqa' })).json();
    assert.deepEqual([g2.state, g2.answer], ['won', 'qqqqa']);
    assert.equal((await s.dd('/v1/daily-diff/guess', { number: 1, word: 'zzzzb' })).status, 409);
  } finally {
    await s.close();
  }
});

test('words outside the list or the format are 422 and use no guess', async () => {
  const s = await boot();
  try {
    await s.dd('/v1/daily-diff/today');
    for (const word of ['zzzzz', 'ZZZZA', 'zzza', 'zzzza ']) assert.equal((await s.dd('/v1/daily-diff/guess', { number: 1, word })).status, 422);
    assert.equal((await s.dd('/v1/daily-diff/guess', { number: 1, word: 42 })).status, 400);
    assert.deepEqual((await (await s.dd('/v1/daily-diff/today')).json()).guesses, []);
  } finally {
    await s.close();
  }
});

test('a guess before opening the puzzle is refused', async () => {
  const s = await boot();
  try {
    assert.equal((await s.dd('/v1/daily-diff/guess', { number: 1, word: 'zzzza' })).status, 409);
  } finally {
    await s.close();
  }
});

test('six misses lose and reveal the answer', async () => {
  const s = await boot();
  try {
    await s.dd('/v1/daily-diff/today');
    let r: { state: string; answer: string; guesses: unknown[] } | undefined;
    for (let i = 0; i < 6; i++) r = await (await s.dd('/v1/daily-diff/guess', { number: 1, word: 'zzzzb' })).json();
    assert.deepEqual([r!.state, r!.answer, r!.guesses.length], ['lost', 'qqqqa', 6]);
  } finally {
    await s.close();
  }
});

test('after midnight UTC the old number is refused and the old game is a fail', async () => {
  const s = await boot({ now: Date.UTC(2026, 9, 7, 23, 59) });
  try {
    await s.dd('/v1/daily-diff/today');
    s.setNow(Date.UTC(2026, 9, 8, 0, 0, 1));
    const r = await s.dd('/v1/daily-diff/guess', { number: 1, word: 'zzzza' });
    assert.deepEqual([r.status, await r.json()], [409, { error: 'new puzzle' }]);
    const t = await (await s.dd('/v1/daily-diff/today')).json();
    assert.deepEqual([t.number, t.day, t.guesses], [2, '2026-10-08', []]);
    const stats = await (await s.dd('/v1/daily-diff/stats')).json();
    assert.deepEqual([stats.played, stats.won], [1, 0]);
  } finally {
    await s.close();
  }
});

test('leaderboard periods; unknown period is 404', async () => {
  const s = await boot();
  try {
    await s.dd('/v1/daily-diff/today');
    await s.dd('/v1/daily-diff/guess', { number: 1, word: 'qqqqa' });
    for (const period of ['today', 'week', 'month', 'all']) {
      const b = await (await s.dd(`/v1/daily-diff/leaderboard/${period}`)).json();
      assert.deepEqual([b.period, b.rows[0].login], [period, 'alice']);
    }
    assert.equal((await s.dd('/v1/daily-diff/leaderboard/year')).status, 404);
    assert.deepEqual(await (await s.dd('/v1/daily-diff/stats')).json(), { played: 1, won: 1, streak: 1, bestStreak: 1, distribution: [1, 0, 0, 0, 0, 0] });
  } finally {
    await s.close();
  }
});

test('without word files Daily Diff is 503 and Block Battle still works', async () => {
  const s = await boot({ words: false });
  try {
    assert.equal((await s.dd('/v1/daily-diff/today')).status, 503);
    assert.equal((await s.call('/v1/leaderboard', {}, s.session)).status, 200);
  } finally {
    await s.close();
  }
});
