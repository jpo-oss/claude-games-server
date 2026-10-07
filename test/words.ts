import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const wordDir = (answers: string, guesses: string) => {
  const d = mkdtempSync(join(tmpdir(), 'dd-'));
  writeFileSync(join(d, 'answers.txt'), answers);
  writeFileSync(join(d, 'guesses.txt'), guesses);
  return d;
};
