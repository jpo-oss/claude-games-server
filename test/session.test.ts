import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/main.ts';

const TOKEN = 'gho_supersecrettoken';
const cfg = { port: 0, databasePath: ':memory:', githubClientId: 'cid', githubClientSecret: 'csecret', maxHeld: 10, maxPlayers: 10, maxConnections: 50, trustProxy: false };

type Seen = { url: string; init: RequestInit };

function fakeGithub(opts: { check?: number | 'throw'; user?: number; login?: string; id?: number } = {}) {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    seen.push({ url: u, init });
    if (u.includes('/applications/')) {
      if (opts.check === 'throw') throw new Error('network down');
      return new Response('{}', { status: opts.check ?? 200 });
    }
    if (opts.user) return new Response('{}', { status: opts.user });
    return Response.json({ login: opts.login ?? 'alice', id: opts.id ?? 7, created_at: '2015-01-02T03:04:05Z' });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

async function boot(gh: ReturnType<typeof fakeGithub>, logs: string[] = []) {
  const s = await start(cfg, { fetch: gh.fetch, log: (l) => logs.push(l) });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${s.port}${path}`, { ...init, headers: { 'x-protocol-version': '3', ...(init.headers as object) } });
  const signIn = () => call('/v1/session', { method: 'POST', body: JSON.stringify({ githubToken: TOKEN }) });
  return { ...s, call, signIn };
}

test('config', async () => {
  const s = await boot(fakeGithub());
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/config`);
    assert.deepEqual(await r.json(), { githubClientId: 'cid', protocol: 3, protocols: { 'block-battle': 3, 'daily-diff': 1 } });
  } finally {
    await s.close();
  }
});

test('token from another app is rejected', async () => {
  const gh = fakeGithub({ check: 404 });
  const s = await boot(gh);
  try {
    const r = await s.signIn();
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'sign-in rejected' });
    assert.equal(gh.seen.length, 1);
  } finally {
    await s.close();
  }
});

test('good token signs in, session works once, sign-out invalidates', async () => {
  const s = await boot(fakeGithub());
  try {
    const r = await s.signIn();
    assert.equal(r.status, 200);
    const { session, login } = (await r.json()) as { session: string; login: string };
    assert.equal(login, 'alice');
    const auth = { authorization: `Bearer ${session}` };
    assert.equal((await s.call('/v1/session', { method: 'DELETE', headers: auth })).status, 204);
    assert.equal((await s.call('/v1/session', { method: 'DELETE', headers: auth })).status, 401);
  } finally {
    await s.close();
  }
});

test('github failure is 502', async () => {
  for (const check of [500, 'throw'] as const) {
    const s = await boot(fakeGithub({ check }));
    try {
      const r = await s.signIn();
      assert.equal(r.status, 502);
      assert.deepEqual(await r.json(), { error: 'github unavailable' });
    } finally {
      await s.close();
    }
  }
});

test('a 403 from GitHub user lookup is 502, a 401 is a rejected sign-in', async () => {
  for (const [user, status, error] of [[403, 502, 'github unavailable'], [401, 401, 'sign-in rejected']] as const) {
    const s = await boot(fakeGithub({ user }));
    try {
      const r = await s.signIn();
      assert.equal(r.status, status);
      assert.deepEqual(await r.json(), { error });
    } finally {
      await s.close();
    }
  }
});

test('github token is never logged or stored', async () => {
  const dir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/bb-');
  const path = dir + '/t.db';
  const logs: string[] = [];
  const gh = fakeGithub();
  const s = await (async () => {
    const x = await start({ ...cfg, databasePath: path }, { fetch: gh.fetch, log: (l) => logs.push(l) });
    return x;
  })();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/session`, {
      method: 'POST',
      headers: { 'x-protocol-version': '3' },
      body: JSON.stringify({ githubToken: TOKEN }),
    });
    assert.equal(r.status, 200);
  } finally {
    await s.close();
  }
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('\n').includes(TOKEN));
  const raw = new DatabaseSync(path, { readOnly: true });
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  for (const t of tables) {
    assert.ok(!JSON.stringify(raw.prepare(`SELECT * FROM ${t.name}`).all()).includes(TOKEN), t.name);
  }
  raw.close();
});

test('no player or session row for a rejected token', async () => {
  const dir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/bb-');
  const path = dir + '/t.db';
  const s = await start({ ...cfg, databasePath: path }, { fetch: fakeGithub({ check: 422 }).fetch, log: () => {} });
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/session`, {
      method: 'POST',
      headers: { 'x-protocol-version': '3' },
      body: JSON.stringify({ githubToken: TOKEN }),
    });
    assert.equal(r.status, 401);
  } finally {
    await s.close();
  }
  const raw = new DatabaseSync(path, { readOnly: true });
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n, 0);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0);
  raw.close();
});

test('check-token uses basic auth and body, user call uses bearer', async () => {
  const gh = fakeGithub();
  const s = await boot(gh);
  try {
    await s.signIn();
    const [check, user] = gh.seen;
    const h = (x: Seen) => new Headers(x.init.headers);
    assert.equal(check.url, 'https://api.github.com/applications/cid/token');
    assert.equal(check.init.method, 'POST');
    assert.equal(h(check).get('authorization'), 'Basic ' + Buffer.from('cid:csecret').toString('base64'));
    assert.deepEqual(JSON.parse(String(check.init.body)), { access_token: TOKEN });
    assert.ok(!check.url.includes(TOKEN));
    assert.equal(user.url, 'https://api.github.com/user');
    assert.equal(h(user).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(h(user).get('x-github-api-version'), '2022-11-28');
  } finally {
    await s.close();
  }
});

test('login that fails the pattern is rejected', async () => {
  const s = await boot(fakeGithub({ login: 'bad login!' }));
  try {
    assert.equal((await s.signIn()).status, 401);
  } finally {
    await s.close();
  }
});

test('sign-in is limited to 5 per minute per ip', async () => {
  const s = await boot(fakeGithub());
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.signIn()).status, 200);
    assert.equal((await s.signIn()).status, 429);
  } finally {
    await s.close();
  }
});

test('config lists every game protocol', async () => {
  const s = await boot(fakeGithub());
  try {
    const body = await (await s.call('/v1/config')).json();
    assert.equal(body.protocol, 3);
    assert.deepEqual(body.protocols, { 'block-battle': 3, 'daily-diff': 1 });
  } finally {
    await s.close();
  }
});
