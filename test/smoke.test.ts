import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/main.ts';

test('GET /health', async () => {
  const { port, close } = await start({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await close();
  }
});
