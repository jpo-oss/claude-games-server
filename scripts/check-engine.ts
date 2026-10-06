import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const ref = readFileSync(new URL('ENGINE_REF', root), 'utf8').trim();
const url = `https://raw.githubusercontent.com/jpo-oss/claude-games/${ref}/plugins/block-battle/hooks/engine.ts`;

let upstream: string;
try {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  upstream = await res.text();
} catch (err) {
  console.error(`check-engine: could not fetch ${url}: ${(err as Error).message}`);
  process.exit(1);
}

if (upstream !== readFileSync(new URL('src/engine.ts', root), 'utf8')) {
  console.error(`check-engine: src/engine.ts differs from the engine at ${ref}. Copy it again or update ENGINE_REF.`);
  process.exit(1);
}
console.log(`check-engine: src/engine.ts matches ${ref}`);
