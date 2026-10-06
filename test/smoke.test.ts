import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/main.ts';

test('GET /health', async () => {
  const { port, close } = await start({ port: 0, databasePath: ':memory:', githubClientId: 'id', githubClientSecret: 'secret', maxHeld: 10, maxPlayers: 10, maxConnections: 10, trustProxy: false });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

test('close can be called twice', async () => {
  const { close } = await start({ port: 0, databasePath: ':memory:', githubClientId: 'id', githubClientSecret: 'secret', maxHeld: 10, maxPlayers: 10, maxConnections: 10, trustProxy: false });
  await Promise.all([close(), close()]);
  await close();
});

// another test can take a probed port before the child binds it, so try a few times
async function spawnServer(dir: string) {
  for (let attempt = 0; ; attempt++) {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
      env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, 'db.sqlite'), GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const up = await new Promise<boolean>((resolve) => {
      child.stdout.on('data', (d: Buffer) => d.toString().includes('listening') && resolve(true));
      child.once('exit', () => resolve(false));
    });
    if (up) return child;
    if (attempt === 2) throw new Error('server never started');
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} shuts the server down cleanly`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-'));
    const child = await spawnServer(dir);
    try {
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      child.kill(signal);
      assert.equal(await exited, 0);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
