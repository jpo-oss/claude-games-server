import { parentPort } from 'node:worker_threads';
import { replay } from './replay.ts';
import type { WorkerJob } from './replay.ts';

parentPort!.once('message', (job: WorkerJob) => {
  parentPort!.postMessage(replay({ ...job, garbage: job.garbage ? new Map(job.garbage) : undefined }));
});
