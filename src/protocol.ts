import type { Input } from './engine.ts';

export const PROTOCOL_VERSION = 2;

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

export type GameLog = {
  steps: number;
  inputs: [number, Input][];
  garbage?: [number, number][];
};

export type ConfigReply = { githubClientId: string; protocol: 2 };
export type SessionBody = { githubToken: string };
export type SessionReply = { session: string; login: string };
export type LeaderboardReply = {
  marathon: { login: string; score: number; lines: number; level: number; at: number }[];
  wins: { login: string; wins: number }[];
};
export type MarathonStartReply = { gameId: string; seed: number };
export type ScoreBody = { gameId: string; log: GameLog };
export type QueueReply =
  | { status: 'waiting' }
  | { status: 'matched'; roomId: string; seed: number; opponent: { login: string } };
export type SyncBody = { seq: number; attacks: number[]; snapshot: string; isOver: boolean };
export type SyncReply = {
  opponent: { login: string; snapshot: string; isOver: boolean } | null;
  incoming: { id: number; lines: number }[];
  result?: { winner: string | null };
};
export type LogBody = { log: GameLog };

const fail = (error: string): { ok: false; status: 400; error: string } => ({ ok: false, status: 400, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const inputNames: readonly string[] = INPUT_NAMES;

const MAX_STEPS = 6_750_000;
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

export function parseGameLog(log: unknown): Parsed<GameLog> {
  if (!isObject(log)) return fail('log must be an object');
  const { steps, inputs, garbage } = log;
  if (!isInt(steps) || steps < 1 || steps > MAX_STEPS) return fail('steps must be an integer from 1 to 6750000');
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) return fail('inputs must be an array of at most 200000 entries');
  let prev = 0;
  for (const e of inputs) {
    if (!Array.isArray(e) || e.length !== 2) return fail('inputs entries must be [step, input] pairs');
    const [s, name] = e;
    if (!isInt(s) || s < 0 || s > steps) return fail('input steps must be integers from 0 to steps');
    if (s < prev) return fail('input steps must not decrease');
    if (typeof name !== 'string' || !inputNames.includes(name)) return fail('unknown input name');
    prev = s;
  }
  if (garbage !== undefined) {
    if (!Array.isArray(garbage) || garbage.length > MAX_GARBAGE) return fail('garbage must be an array of at most 10000 entries');
    prev = 0;
    for (const e of garbage) {
      if (!Array.isArray(e) || e.length !== 2) return fail('garbage entries must be [step, attackId] pairs');
      const [s, id] = e;
      if (!isInt(s) || s < 0 || s > steps) return fail('garbage steps must be integers from 0 to steps');
      if (s < prev) return fail('garbage steps must not decrease');
      if (!isInt(id) || id < 1) return fail('garbage attackId must be a positive integer');
      prev = s;
    }
  }
  return { ok: true, value: log as GameLog };
}

export function parseScoreBody(body: unknown): Parsed<ScoreBody> {
  if (!isObject(body)) return fail('body must be an object');
  const { gameId } = body;
  if (typeof gameId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(gameId)) {
    return fail('gameId must be 1 to 64 letters, digits, - or _');
  }
  const log = parseGameLog(body.log);
  if (!log.ok) return log;
  return { ok: true, value: { gameId, log: log.value } };
}

export function parseLogBody(body: unknown): Parsed<LogBody> {
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
