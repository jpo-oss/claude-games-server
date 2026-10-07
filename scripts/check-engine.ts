import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const ref = readFileSync(new URL('ENGINE_REF', root), 'utf8').trim();
const FILES = ['engine.ts', 'bot.ts', 'match.ts'];

let failed = false;
for (const file of FILES) {
  const url = `https://raw.githubusercontent.com/jpo-oss/claude-games/${ref}/plugins/block-battle/hooks/${file}`;
  let upstream: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    upstream = await res.text();
  } catch (err) {
    console.error(`check-engine: could not fetch ${url}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (upstream !== readFileSync(new URL(`src/${file}`, root), 'utf8')) {
    console.error(`check-engine: src/${file} differs from the game at ${ref}. Copy it again or update ENGINE_REF.`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`check-engine: src/${FILES.join(', src/')} match ${ref}`);
