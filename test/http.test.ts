import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/http.ts';
import type { Route } from '../src/http.ts';
import { applyLimits, loadConfig } from '../src/main.ts';

const routes: Route[] = [
  { method: 'GET', path: '/health', auth: false, handler: async () => ({ status: 200, body: { ok: true } }) },
  { method: 'POST', path: '/echo', auth: false, handler: async (c) => ({ status: 200, body: { got: c.body } }) },
  { method: 'POST', path: '/big', auth: false, bodyLimit: 10_000, handler: async () => ({ status: 204 }) },
  { method: 'POST', path: '/upload', auth: true, bodyLimit: 2_000_000, handler: async () => ({ status: 204 }) },
  { method: 'GET', path: '/me', auth: true, handler: async (c) => ({ status: 200, body: { login: c.login, ip: c.ip } }) },
  { method: 'GET', path: '/room/:room/x', auth: false, handler: async (c) => ({ status: 200, body: c.params }) },
  { method: 'GET', path: '/boom', auth: false, handler: async () => { throw new Error('secret detail'); } },
  { method: 'POST', path: '/slow', auth: false, limit: { ratePerSec: 5 / 60, burst: 5, by: 'ip' }, handler: async () => ({ status: 204 }) },
];

async function serve(opts: { trustProxy?: boolean; log?: (l: string) => void; now?: () => number } = {}) {
  const handler = createHandler({
    routes,
    findSession: (k) => (k === 'good' ? 'alice' : null),
    trustProxy: opts.trustProxy ?? false,
    log: opts.log ?? (() => {}),
    now: opts.now,
  });
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'x-protocol-version': '3', ...(init.headers as object) } });
  return { call, base, close: () => { server.closeAllConnections(); server.close(); } };
}

test('404 and 405', async () => {
  const s = await serve();
  try {
    const a = await s.call('/nope');
    assert.equal(a.status, 404);
    assert.deepEqual(await a.json(), { error: 'not found' });
    const b = await s.call('/health', { method: 'POST' });
    assert.equal(b.status, 405);
    assert.deepEqual(await b.json(), { error: 'method not allowed' });
  } finally { s.close(); }
});

test('426 on missing or wrong protocol, /health exempt', async () => {
  const s = await serve();
  try {
    const none = await fetch(s.base + '/echo', { method: 'POST', body: '{}' });
    assert.equal(none.status, 426);
    assert.deepEqual(await none.json(), { error: 'protocol 3 required' });
    const wrong = await fetch(s.base + '/echo', { method: 'POST', body: '{}', headers: { 'x-protocol-version': '2' } });
    assert.equal(wrong.status, 426);
    assert.equal((await fetch(s.base + '/health')).status, 200);
  } finally { s.close(); }
});

test('params are extracted', async () => {
  const s = await serve();
  try {
    assert.deepEqual(await (await s.call('/room/r1/x')).json(), { room: 'r1' });
  } finally { s.close(); }
});

test('413 over the cap, bigger bodyLimit accepts', async () => {
  const s = await serve();
  try {
    const body = JSON.stringify({ a: 'x'.repeat(5000) });
    const small = await s.call('/echo', { method: 'POST', body });
    assert.equal(small.status, 413);
    assert.deepEqual(await small.json(), { error: 'body too large' });
    assert.equal((await s.call('/big', { method: 'POST', body })).status, 204);
    assert.equal((await s.call('/big', { method: 'POST', body: 'x'.repeat(20_000) })).status, 413);
  } finally { s.close(); }
});

test('400 bad json, empty body ok', async () => {
  const s = await serve();
  try {
    const bad = await s.call('/echo', { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'bad json' });
    assert.equal((await s.call('/echo', { method: 'POST' })).status, 200);
  } finally { s.close(); }
});

test('401 without or with a bad bearer, 200 with a good one', async () => {
  const s = await serve();
  try {
    const none = await s.call('/me');
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { error: 'sign in first' });
    assert.equal((await s.call('/me', { headers: { authorization: 'Bearer bad' } })).status, 401);
    assert.equal((await s.call('/me', { headers: { authorization: 'Basic good' } })).status, 401);
    const ok = await s.call('/me', { headers: { authorization: 'Bearer good' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).login, 'alice');
  } finally { s.close(); }
});

test('429 after the IP burst', async () => {
  const s = await serve({ now: () => 0 });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 41; i++) codes.push((await s.call('/health')).status);
    assert.equal(codes.slice(0, 40).every((c) => c === 200), true);
    assert.equal(codes[40], 429);
  } finally { s.close(); }
});

test('429 after the per-session burst, body says slow down', async () => {
  const s = await serve({ now: () => 0 });
  try {
    const h = { authorization: 'Bearer good', 'x-forwarded-for': '' };
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await s.call('/me', { headers: h })).status);
    assert.equal(codes.slice(0, 24).every((c) => c === 200), true);
    assert.equal(codes[24], 429);
    assert.deepEqual(await (await s.call('/me', { headers: h })).json(), { error: 'slow down' });
  } finally { s.close(); }
});

test('route limit is enforced', async () => {
  const s = await serve({ now: () => 0 });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await s.call('/slow', { method: 'POST' })).status);
    assert.deepEqual(codes, [204, 204, 204, 204, 204, 429]);
  } finally { s.close(); }
});

test('500 hides the error', async () => {
  const s = await serve();
  try {
    const r = await s.call('/boom');
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { error: 'server error' });
    assert.equal(text.includes('secret'), false);
  } finally { s.close(); }
});

test('500 is logged with the error name only', async () => {
  const lines: string[] = [];
  const s = await serve({ log: (l) => lines.push(l) });
  try {
    assert.equal((await s.call('/boom')).status, 500);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.includes('GET /boom 500 - error=Error'), lines.join('\n'));
    assert.equal(lines.join('\n').includes('secret'), false);
  } finally { s.close(); }
});

test('an auth route answers 401 before reading the body', async () => {
  const s = await serve();
  try {
    const port = new URL(s.base).port;
    const reply = await new Promise<string>((resolve) => {
      const sock = connect(Number(port), '127.0.0.1', () =>
        sock.write('POST /upload HTTP/1.1\r\nHost: x\r\nX-Protocol-Version: 3\r\nContent-Length: 1048576\r\n\r\n' + 'x'.repeat(1000)));
      const timer = setTimeout(() => { sock.destroy(); resolve('timeout'); }, 2_000);
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('close', () => { clearTimeout(timer); resolve(data); });
    });
    assert.match(reply.split('\r\n')[0]!, /^HTTP\/1\.1 401/);
    assert.ok(reply.includes('{"error":"sign in first"}'));
  } finally { s.close(); }
});

test('log line has no token, body or ip', async () => {
  const lines: string[] = [];
  const s = await serve({ log: (l) => lines.push(l) });
  try {
    await s.call('/me', { headers: { authorization: 'Bearer good' } });
    await s.call('/echo', { method: 'POST', body: JSON.stringify({ pw: 'hunter2' }) });
    await s.call('/room/r9/x');
    await new Promise((r) => setTimeout(r, 20));
    assert.match(lines[0], /^GET \/me 200 alice \d+ms$/);
    assert.match(lines[1], /^POST \/echo 200 - \d+ms$/);
    assert.match(lines[2], /^GET \/room\/:room\/x 200 - \d+ms$/);
    const all = lines.join('\n');
    assert.equal(/good|hunter2|127\.0\.0\.1/.test(all), false);
  } finally { s.close(); }
});

test('X-Forwarded-For only honored with trustProxy', async () => {
  const off = await serve();
  const on = await serve({ trustProxy: true });
  const h = { authorization: 'Bearer good', 'x-forwarded-for': '9.9.9.9, 1.1.1.1' };
  try {
    assert.equal((await (await off.call('/me', { headers: h })).json()).ip, '127.0.0.1');
    assert.equal((await (await on.call('/me', { headers: h })).json()).ip, '1.1.1.1');
  } finally { off.close(); on.close(); }
});

test('loadConfig defaults', () => {
  assert.deepEqual(loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' }), {
    port: 8080,
    databasePath: './data/server.db',
    githubClientId: 'id',
    githubClientSecret: 's',
    maxHeld: 2000,
    maxPlayers: 1000,
    maxConnections: 4000,
    trustProxy: false,
    dailyDiffWordsDir: undefined,
  });
});

test('loadConfig reads overrides', () => {
  const c = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', PORT: '9000', TRUST_PROXY: 'true', DATABASE_PATH: '/x.db' });
  assert.equal(c.port, 9000);
  assert.equal(c.trustProxy, true);
  assert.equal(c.databasePath, '/x.db');
});

test('loadConfig errors', () => {
  assert.throws(() => loadConfig({ GITHUB_CLIENT_ID: 'id' }), /GITHUB_CLIENT_SECRET/);
  assert.throws(() => loadConfig({ GITHUB_CLIENT_SECRET: 's' }), /GITHUB_CLIENT_ID/);
  assert.throws(() => loadConfig({ GITHUB_CLIENT_ID: 'i', GITHUB_CLIENT_SECRET: 's', PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ GITHUB_CLIENT_ID: 'i', GITHUB_CLIENT_SECRET: 's', MAX_HELD: '0' }), /MAX_HELD/);
  assert.throws(() => loadConfig({ GITHUB_CLIENT_ID: 'i', GITHUB_CLIENT_SECRET: 's', MAX_CONNECTIONS: '-1' }), /MAX_CONNECTIONS/);
});

test('last X-Forwarded-For entry wins, garbage falls back to the socket', async () => {
  const on = await serve({ trustProxy: true });
  const ip = async (xff: string) =>
    (await (await on.call('/me', { headers: { authorization: 'Bearer good', 'x-forwarded-for': xff } })).json()).ip;
  try {
    assert.equal(await ip('6.6.6.6, 7.7.7.7, 2001:db8::1'), '2001:db8::1');
    assert.equal(await ip('1.1.1.1, not-an-ip'), '127.0.0.1');
    assert.equal(await ip('1.1.1.1, ' + 'a'.repeat(8000)), '127.0.0.1');
    assert.equal(await ip('1.1.1.1,'), '127.0.0.1');
  } finally { on.close(); }
});

test('applyLimits sets the timeouts and connection cap', () => {
  const server = createServer();
  applyLimits(server, 123);
  assert.deepEqual(
    [server.headersTimeout, server.requestTimeout, server.keepAliveTimeout, server.maxConnections],
    [10_000, 15_000, 5_000, 123],
  );
});

test('a handler that outlives requestTimeout after the body is read still completes', async () => {
  const slow: Route = {
    method: 'POST', path: '/hold', auth: false,
    handler: async () => { await new Promise((r) => setTimeout(r, 700)); return { status: 200, body: { held: true } }; },
  };
  const server = createServer({ connectionsCheckingInterval: 50 }, createHandler({ routes: [slow], findSession: () => null, trustProxy: false, log: () => {} }));
  applyLimits(server, 100, { headers: 200, request: 300, keepAlive: 200 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hold`, { method: 'POST', headers: { 'x-protocol-version': '3' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { held: true });

    const status = await new Promise<string>((resolve) => {
      const sock = connect(port, '127.0.0.1', () =>
        sock.write('POST /hold HTTP/1.1\r\nHost: x\r\nX-Protocol-Version: 3\r\nContent-Length: 100\r\n\r\n{'));
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('close', () => resolve(data.split('\r\n')[0]));
    });
    assert.match(status, /408/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

async function serveRoutes(list: Route[]) {
  const server = createServer(createHandler({ routes: list, findSession: () => null, trustProxy: false, log: () => {} }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => { server.closeAllConnections(); server.close(); } };
}

test('each game is checked against its own protocol version', async () => {
  const ok = async () => ({ status: 200, body: {} });
  const s = await serveRoutes([
    { method: 'GET', path: '/v1/bb', auth: false, game: 'block-battle', handler: ok },
    { method: 'GET', path: '/v1/dd', auth: false, game: 'daily-diff', handler: ok },
    { method: 'GET', path: '/v1/any', auth: false, handler: ok },
  ]);
  const get = (path: string, headers: Record<string, string>) => fetch(`${s.url}${path}`, { headers }).then((r) => r.status);
  try {
    assert.equal(await get('/v1/bb', { 'x-protocol-version': '3' }), 200);
    assert.equal(await get('/v1/dd', { 'x-protocol-version': '1', 'x-game': 'daily-diff' }), 200);
    assert.equal(await get('/v1/dd', { 'x-protocol-version': '3' }), 426);
    assert.equal(await get('/v1/bb', { 'x-protocol-version': '1', 'x-game': 'daily-diff' }), 426);
    assert.equal(await get('/v1/any', { 'x-protocol-version': '1', 'x-game': 'daily-diff' }), 200);
    assert.equal(await get('/v1/any', { 'x-protocol-version': '3' }), 200);
    assert.equal(await get('/v1/any', { 'x-protocol-version': '1', 'x-game': 'constructor' }), 426);
    const r = await fetch(`${s.url}/v1/bb`, { headers: { 'x-protocol-version': '2' } });
    assert.deepEqual(await r.json(), { error: 'protocol 3 required' });
  } finally {
    s.close();
  }
});
