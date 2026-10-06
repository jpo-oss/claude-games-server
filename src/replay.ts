import { Worker } from 'node:worker_threads';
import { newGame, receiveGarbage, step } from './engine.ts';
import type { Input, Mode } from './engine.ts';
import type { GameLog } from './protocol.ts';

export const STEP_MS = 16;

export type ReplayJob = {
  seed: number;
  mode: Mode;
  log: GameLog;
  garbage?: Map<number, number>;
};

export type ReplayResult =
  | {
      ok: true;
      score: number;
      lines: number;
      level: number;
      isOver: boolean;
      topOutStep: number | null;
      attacks: number[];
    }
  | { ok: false; error: string };

// The log must already have passed parseGameLog.
export function replay(job: ReplayJob): ReplayResult {
  const { log } = job;
  let game = newGame(job.mode, job.seed);
  const attacks: number[] = [];
  let topOutStep: number | null = null;
  let ii = 0;
  let gi = 0;
  const garbage = log.garbage ?? [];
  for (let i = 0; i < log.steps; i++) {
    while (gi < garbage.length && garbage[gi]![0] <= i) {
      const lines = job.garbage?.get(garbage[gi]![1]);
      if (lines === undefined) return { ok: false, error: 'unknown attack' };
      if (garbage[gi]![0] === i) game = receiveGarbage(game, lines);
      gi++;
    }
    const inputs: Input[] = [];
    while (ii < log.inputs.length && log.inputs[ii]![0] <= i) {
      if (log.inputs[ii]![0] === i) inputs.push(log.inputs[ii]![1]);
      ii++;
    }
    const r = step(game, inputs, STEP_MS);
    game = r.game;
    for (const e of r.events) if (e.type === 'lineClear' && e.attack > 0) attacks.push(e.attack);
    if (game.isOver) {
      topOutStep = i;
      break;
    }
  }
  if (topOutStep !== null) {
    const lastInput = log.inputs.at(-1)?.[0] ?? -1;
    const lastGarbage = garbage.at(-1)?.[0] ?? -1;
    if (lastInput > topOutStep || lastGarbage > topOutStep) return { ok: false, error: 'input after game over' };
  }
  return { ok: true, score: game.score, lines: game.lines, level: game.level, isOver: game.isOver, topOutStep, attacks };
}

export type WorkerJob = Omit<ReplayJob, 'garbage'> & { garbage?: [number, number][] };

type Pending = {
  job: ReplayJob;
  resolve: (r: ReplayResult) => void;
};

export function createReplayer(opts: { maxConcurrent?: number; timeoutMs?: number; maxQueue?: number } = {}) {
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxQueue = opts.maxQueue ?? 32;
  const queue: Pending[] = [];
  // A slot stays taken until its worker has fully exited.
  const slots = new Set<Promise<void>>();
  const finishers = new Set<(r: ReplayResult) => void>();
  let closed = false;

  function pump() {
    while (!closed && slots.size < maxConcurrent && queue.length > 0) start(queue.shift()!);
  }

  function start({ job, resolve }: Pending) {
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let release!: () => void;
    const slot = new Promise<void>((r) => (release = r));
    slots.add(slot);
    const finish = (r: ReplayResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finishers.delete(finish);
      resolve(r);
      void (worker ? worker.terminate() : Promise.resolve()).catch(() => undefined).then(() => {
        slots.delete(slot);
        release();
        pump();
      });
    };
    finishers.add(finish);
    try {
      worker = new Worker(new URL('./replay-worker.ts', import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
      worker.once('message', (r: ReplayResult) => finish(r));
      worker.once('error', () => finish({ ok: false, error: 'replay failed' }));
      worker.once('exit', () => finish({ ok: false, error: 'replay failed' }));
      const msg: WorkerJob = { ...job, garbage: job.garbage ? [...job.garbage] : undefined };
      worker.postMessage(msg);
    } catch {
      finish({ ok: false, error: 'replay failed' });
    }
  }

  return {
    run(job: ReplayJob): Promise<ReplayResult> {
      if (closed) return Promise.resolve({ ok: false, error: 'closed' });
      if (slots.size >= maxConcurrent && queue.length >= maxQueue) return Promise.resolve({ ok: false, error: 'busy' });
      return new Promise((resolve) => {
        queue.push({ job, resolve });
        pump();
      });
    },
    active: () => slots.size,
    async close(): Promise<void> {
      closed = true;
      for (const p of queue.splice(0)) p.resolve({ ok: false, error: 'closed' });
      for (const f of [...finishers]) f({ ok: false, error: 'closed' });
      await Promise.all([...slots]);
    },
  };
}
