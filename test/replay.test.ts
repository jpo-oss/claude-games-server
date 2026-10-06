import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, step, receiveGarbage } from '../src/engine.ts';
import type { Input, Mode } from '../src/engine.ts';
import type { GameLog } from '../src/protocol.ts';
import { createReplayer, replay, STEP_MS } from '../src/replay.ts';

const POOL: Input[] = [
  'hardDrop', 'hardDrop', 'hardDrop', 'left', 'right', 'rotateCW', 'rotateCCW',
  'rotate180', 'hold', 'softDropOn', 'softDropOff', 'softDropStep',
];

type Run = {
  log: GameLog;
  garbage: Map<number, number>;
  score: number;
  lines: number;
  level: number;
  isOver: boolean;
  topOutStep: number | null;
  attacks: number[];
};

function play(mode: Mode, seed: number, steps: number, garbageAt: [number, number][] = []): Run {
  let rnd = seed >>> 0;
  const next = () => (rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const garbage = new Map(garbageAt.map(([, lines], i) => [i + 1, lines]));
  const log: GameLog = { steps, inputs: [] };
  if (garbageAt.length) log.garbage = garbageAt.map(([s], i) => [s, i + 1]);
  let game = newGame(mode, seed);
  let topOutStep: number | null = null;
  const attacks: number[] = [];
  for (let i = 0; i < steps; i++) {
    for (const [s, lines] of garbageAt) if (s === i) game = receiveGarbage(game, lines);
    const inputs: Input[] = [];
    if (next() < 0.3) inputs.push(POOL[Math.floor(next() * POOL.length)]!);
    for (const inp of inputs) log.inputs.push([i, inp]);
    const r = step(game, inputs, STEP_MS);
    game = r.game;
    for (const e of r.events) if (e.type === 'lineClear' && e.attack > 0) attacks.push(e.attack);
    if (game.isOver) {
      topOutStep = i;
      break;
    }
  }
  if (topOutStep !== null && log.garbage) log.garbage = log.garbage.filter(([s]) => s <= topOutStep!);
  return { log, garbage, score: game.score, lines: game.lines, level: game.level, isOver: game.isOver, topOutStep, attacks };
}

function ok(r: ReturnType<typeof replay>) {
  assert.equal(r.ok, true);
  return r as Extract<typeof r, { ok: true }>;
}

test('replay matches a direct engine run', () => {
  const run = play('marathon', 7, 4000);
  assert.ok(run.score > 0);
  const r = ok(replay({ seed: 7, mode: 'marathon', log: run.log }));
  assert.equal(r.score, run.score);
  assert.equal(r.lines, run.lines);
  assert.equal(r.level, run.level);
  assert.equal(r.isOver, run.isOver);
  assert.equal(r.topOutStep, run.topOutStep);
  assert.deepEqual(r.attacks, run.attacks);
});

test('changing one input changes the result', () => {
  const run = play('marathon', 7, 4000);
  const base = ok(replay({ seed: 7, mode: 'marathon', log: run.log }));
  const idx = run.log.inputs.findIndex(([, inp]) => inp === 'hardDrop');
  const inputs = run.log.inputs.map((e) => [...e] as [number, Input]);
  inputs[idx]![1] = 'hold';
  const r = ok(replay({ seed: 7, mode: 'marathon', log: { ...run.log, inputs } }));
  assert.ok(r.score !== base.score || r.lines !== base.lines);
});

test('battle garbage replays identically and a missing id fails', () => {
  const run = play('battle', 11, 3000, [[100, 2], [150, 3]]);
  const job = { seed: 11, mode: 'battle' as const, log: run.log, garbage: run.garbage };
  const r = ok(replay(job));
  assert.equal(r.score, run.score);
  assert.equal(r.lines, run.lines);
  assert.equal(r.isOver, run.isOver);
  assert.equal(r.topOutStep, run.topOutStep);
  assert.deepEqual(replay({ ...job, garbage: new Map([[2, 3]]) }), { ok: false, error: 'unknown attack' });
});

test('input after top-out is rejected', () => {
  const run = play('marathon', 3, 20000);
  assert.ok(run.topOutStep !== null, 'run should top out');
  const log: GameLog = { steps: run.log.steps, inputs: [...run.log.inputs, [run.topOutStep! + 5, 'left']] };
  assert.deepEqual(replay({ seed: 3, mode: 'marathon', log }), { ok: false, error: 'input after game over' });
});

test('10,000 steps replay in under a second', () => {
  const log: GameLog = { steps: 10000, inputs: [] };
  for (let i = 0; i < 10000; i += 7) log.inputs.push([i, i % 3 === 0 ? 'left' : 'rotateCW']);
  const t = performance.now();
  const r = ok(replay({ seed: 5, mode: 'marathon', log }));
  assert.ok(performance.now() - t < 1000);
  assert.ok(r.topOutStep === null || r.topOutStep < 10000);
});

test('createReplayer runs jobs in a worker', async () => {
  const run = play('marathon', 7, 3000);
  const job = { seed: 7, mode: 'marathon' as const, log: run.log };
  const rp = createReplayer();
  try {
    assert.deepEqual(await rp.run(job), replay(job));
  } finally {
    await rp.close();
  }
});

test('maxConcurrent 1 runs jobs in order', async () => {
  const a = { seed: 1, mode: 'marathon' as const, log: play('marathon', 1, 500).log };
  const b = { seed: 2, mode: 'marathon' as const, log: play('marathon', 2, 500).log };
  const rp = createReplayer({ maxConcurrent: 1 });
  const done: string[] = [];
  try {
    const [ra, rb] = await Promise.all([
      rp.run(a).then((r) => (done.push('a'), r)),
      rp.run(b).then((r) => (done.push('b'), r)),
    ]);
    assert.deepEqual(done, ['a', 'b']);
    assert.deepEqual(ra, replay(a));
    assert.deepEqual(rb, replay(b));
  } finally {
    await rp.close();
  }
});

test('timeout resolves with a timeout error', async () => {
  const log: GameLog = { steps: 2_000_000, inputs: [] };
  const rp = createReplayer({ timeoutMs: 1 });
  try {
    assert.deepEqual(await rp.run({ seed: 1, mode: 'marathon', log }), { ok: false, error: 'timeout' });
  } finally {
    await rp.close();
  }
});

test('queued jobs resolve closed after close()', async () => {
  const log: GameLog = { steps: 2_000_000, inputs: [] };
  const rp = createReplayer({ maxConcurrent: 1 });
  const first = rp.run({ seed: 1, mode: 'marathon', log });
  const second = rp.run({ seed: 2, mode: 'marathon', log });
  await rp.close();
  assert.deepEqual(await second, { ok: false, error: 'closed' });
  assert.deepEqual(await first, { ok: false, error: 'closed' });
});
