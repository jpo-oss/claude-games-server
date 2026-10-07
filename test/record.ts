import { snapshot } from '../src/engine.ts';
import type { Input } from '../src/engine.ts';
import { botInputs, botSaw, newBot } from '../src/bot.ts';
import type { Level } from '../src/bot.ts';
import { newMatch, stepMatch } from '../src/match.ts';
import type { Match } from '../src/match.ts';
import type { ReplayLog } from '../src/protocol.ts';

// The same script and digest live in claude-games plugins/block-battle/tests/match.test.ts.
export const script = (i: number): Input[] => (i % 40 === 39 ? ['hardDrop'] : i % 13 === 0 ? ['left'] : []);

// Plays a match as the Client does; `pilot` puts a bot in the player's seat instead of the script.
export function record(seed: number, level: Level, cap: number, pilot?: Level): { log: ReplayLog; m: Match } {
  const m = newMatch(seed, level);
  const brain = pilot ? newBot(pilot, seed + 1) : null;
  const log: ReplayLog = { steps: 0, inputs: [] };
  for (let i = 0; i < cap && !m.winner; i++) {
    const inputs = brain ? botInputs(brain, m.me) : script(i);
    for (const x of inputs) log.inputs.push([i, x]);
    const r = stepMatch(m, inputs);
    if (brain) botSaw(brain, r.me);
    log.steps = i + 1;
  }
  return { log, m };
}

export function digest(m: Match): string {
  let h = 0x811c9dc5;
  const s = snapshot(m.me) + snapshot(m.bot);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${m.steps} ${m.winner} ${(h >>> 0).toString(16)}`;
}
