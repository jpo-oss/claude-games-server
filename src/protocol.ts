import type { Input } from './engine.ts';
import { LEVELS } from './bot.ts';
import type { Level } from './bot.ts';

export const PROTOCOL_VERSION = 3;

export const INPUT_NAMES = [
  'left',
  'right',
  'softDropOn',
  'softDropOff',
  'softDropStep',
  'hardDrop',
  'rotateCW',
  'rotateCCW',
  'rotate180',
  'hold',
] as const satisfies readonly Input[];

// Fails to compile if the engine gains an input this list lacks.
type MissingInputs = Exclude<Input, (typeof INPUT_NAMES)[number]>;
const _allInputsListed: MissingInputs extends never ? true : never = true;
void _allInputsListed;

export type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400; error: string };

// Wire form. `inputs` is flat [stepDelta, code, ...] pairs where code indexes INPUT_NAMES and each
// delta counts from the previous pair's step (the first from 0). `garbage` is [stepDelta, attackId, ...].
export type GameLog = {
  steps: number;
  inputs: number[];
  garbage?: number[];
};

export type ReplayLog = {
  steps: number;
  inputs: [number, Input][];
  garbage?: [number, number][];
};

export type ConfigReply = { githubClientId: string; protocol: 3 };
export type SessionBody = { githubToken: string };
export type SessionReply = { session: string; login: string };
export type BotRow = { login: string; ms: number; at: number };
export type LeaderboardReply = {
  marathon: { login: string; score: number; lines: number; level: number; at: number }[];
  wins: { login: string; wins: number }[];
  bot: Record<Level, BotRow[]>;
};
export type BotStartBody = { level: Level };
export type BotStartReply = { gameId: string; seed: number };
export type MarathonStartReply = { gameId: string; seed: number };
export type ScoreBody = { gameId: string; log: GameLog };
export type ParsedScoreBody = { gameId: string; log: ReplayLog };
export type QueueStatus =
  | { status: 'waiting' }
  | { status: 'matched'; roomId: string; seed: number; opponent: { login: string } };
export type Online = { playing: number; looking: number };
export type QueueReply = QueueStatus & { online: Online };
export type SyncBody = { seq: number; attacks: number[]; snapshot: string; isOver: boolean };
export type SyncReply = {
  opponent: { login: string; snapshot: string; isOver: boolean } | null;
  incoming: { id: number; lines: number }[];
  result?: { winner: string | null };
};
export type LogBody = { log: GameLog };
export type ParsedLogBody = { log: ReplayLog };

const fail = (error: string): { ok: false; status: 400; error: string } => ({ ok: false, status: 400, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);

export const MAX_STEPS = 450_000;
const MAX_INPUTS = 200_000;
const MAX_GARBAGE = 10_000;

export function parseSessionBody(body: unknown): Parsed<SessionBody> {
  if (!isObject(body)) return fail('body must be an object');
  const t = body.githubToken;
  if (typeof t !== 'string' || t.length > 255 || !/^[\x21-\x7e]+$/.test(t)) {
    return fail('githubToken must be 1 to 255 visible characters');
  }
  return { ok: true, value: { githubToken: t } };
}

export function parseBotStart(body: unknown): Parsed<BotStartBody> {
  if (!isObject(body)) return fail('body must be an object');
  const { level } = body;
  if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) return fail('level must be easy, medium or hard');
  return { ok: true, value: { level: level as Level } };
}

export function encodeLog(log: ReplayLog): GameLog {
  const pairs = <T>(entries: [number, T][], code: (v: T) => number) => {
    const out: number[] = [];
    let prev = 0;
    for (const [s, v] of entries) {
      out.push(s - prev, code(v));
      prev = s;
    }
    return out;
  };
  const out: GameLog = { steps: log.steps, inputs: pairs(log.inputs, (i) => INPUT_NAMES.indexOf(i)) };
  if (log.garbage) out.garbage = pairs(log.garbage, (id) => id);
  return out;
}

export function parseGameLog(log: unknown): Parsed<ReplayLog> {
  if (!isObject(log)) return fail('log must be an object');
  const { steps, inputs, garbage } = log;
  if (!isInt(steps) || steps < 1 || steps > MAX_STEPS) return fail('steps must be an integer from 1 to 450000');
  if (!Array.isArray(inputs) || inputs.length % 2 !== 0 || inputs.length > MAX_INPUTS * 2) {
    return fail('inputs must be an array of at most 200000 [stepDelta, code] pairs');
  }
  const decoded: ReplayLog = { steps, inputs: [] };
  let at = 0;
  for (let i = 0; i < inputs.length; i += 2) {
    const d: unknown = inputs[i];
    const code: unknown = inputs[i + 1];
    if (!isInt(d) || d < 0) return fail('input step deltas must be integers of 0 or more');
    at += d;
    if (at > steps) return fail('input steps must be from 0 to steps');
    if (!isInt(code) || code < 0 || code >= INPUT_NAMES.length) return fail('input codes must be integers from 0 to 9');
    decoded.inputs.push([at, INPUT_NAMES[code]!]);
  }
  if (garbage !== undefined) {
    if (!Array.isArray(garbage) || garbage.length % 2 !== 0 || garbage.length > MAX_GARBAGE * 2) {
      return fail('garbage must be an array of at most 10000 [stepDelta, attackId] pairs');
    }
    decoded.garbage = [];
    at = 0;
    for (let i = 0; i < garbage.length; i += 2) {
      const d: unknown = garbage[i];
      const id: unknown = garbage[i + 1];
      if (!isInt(d) || d < 0) return fail('garbage step deltas must be integers of 0 or more');
      at += d;
      if (at > steps) return fail('garbage steps must be from 0 to steps');
      if (!isInt(id) || id < 1) return fail('garbage attackId must be a positive integer');
      decoded.garbage.push([at, id]);
    }
  }
  return { ok: true, value: decoded };
}

export function parseScoreBody(body: unknown): Parsed<ParsedScoreBody> {
  if (!isObject(body)) return fail('body must be an object');
  const { gameId } = body;
  if (typeof gameId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(gameId)) {
    return fail('gameId must be 1 to 64 letters, digits, - or _');
  }
  const log = parseGameLog(body.log);
  if (!log.ok) return log;
  return { ok: true, value: { gameId, log: log.value } };
}

export function parseLogBody(body: unknown): Parsed<ParsedLogBody> {
  if (!isObject(body)) return fail('body must be an object');
  const log = parseGameLog(body.log);
  if (!log.ok) return log;
  return { ok: true, value: { log: log.value } };
}

export function parseSyncBody(body: unknown): Parsed<SyncBody> {
  if (!isObject(body)) return fail('body must be an object');
  const { seq, attacks, snapshot, isOver } = body;
  if (!isInt(seq) || seq < 0) return fail('seq must be an integer of 0 or more');
  if (!Array.isArray(attacks) || attacks.length > 20 || !attacks.every((a) => isInt(a) && a >= 1 && a <= 40)) {
    return fail('attacks must be up to 20 integers from 1 to 40');
  }
  if (typeof snapshot !== 'string' || snapshot.length > 400 || !/^[.IOTSZJLG]*$/.test(snapshot)) {
    return fail('snapshot must be up to 400 board characters');
  }
  if (typeof isOver !== 'boolean') return fail('isOver must be a boolean');
  return { ok: true, value: { seq, attacks, snapshot, isOver } };
}
