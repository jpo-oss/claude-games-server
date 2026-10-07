import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_NAMES,
  type ConfigReply,
  type LeaderboardReply,
  type QueueReply,
  type SessionReply,
  type SyncReply,
  PROTOCOL_VERSION,
  encodeLog,
  parseGameLog,
  parseLogBody,
  parseScoreBody,
  parseSessionBody,
  parseSyncBody,
} from '../src/protocol.ts';
import type { Input } from '../src/engine.ts';

function bad(r: { ok: boolean }, error?: string) {
  assert.equal(r.ok, false);
  const e = r as { ok: false; status: number; error: string };
  assert.equal(e.status, 400);
  if (error) assert.equal(e.error, error);
}

test('protocol version is 3', () => {
  assert.equal(PROTOCOL_VERSION, 3);
});

test('input names list has 10 entries', () => {
  assert.equal(new Set(INPUT_NAMES).size, 10);
});

test('parseSessionBody accepts a token', () => {
  assert.deepEqual(parseSessionBody({ githubToken: 'gho_abc123' }), { ok: true, value: { githubToken: 'gho_abc123' } });
});

test('parseSessionBody rejections', () => {
  bad(parseSessionBody(null), 'body must be an object');
  bad(parseSessionBody([]), 'body must be an object');
  bad(parseSessionBody({}), 'githubToken must be 1 to 255 visible characters');
  bad(parseSessionBody({ githubToken: 5 }), 'githubToken must be 1 to 255 visible characters');
  bad(parseSessionBody({ githubToken: '' }), 'githubToken must be 1 to 255 visible characters');
  bad(parseSessionBody({ githubToken: 'a'.repeat(256) }), 'githubToken must be 1 to 255 visible characters');
  bad(parseSessionBody({ githubToken: 'has space' }), 'githubToken must be 1 to 255 visible characters');
  bad(parseSessionBody({ githubToken: 'tab\t' }), 'githubToken must be 1 to 255 visible characters');
});

const log = { steps: 100, inputs: [0, 0, 10, 5] };

test('parseGameLog decodes step deltas and input codes', () => {
  assert.deepEqual(parseGameLog({ steps: 20, inputs: [0, 0, 10, 5, 0, 9], garbage: [3, 1, 4, 2] }), {
    ok: true,
    value: { steps: 20, inputs: [[0, 'left'], [10, 'hardDrop'], [10, 'hold']], garbage: [[3, 1], [7, 2]] },
  });
  assert.deepEqual(parseGameLog({ steps: 1, inputs: [] }), { ok: true, value: { steps: 1, inputs: [] } });
});

test('parseGameLog accepts valid logs', () => {
  assert.equal(parseGameLog(log).ok, true);
  assert.equal(parseGameLog({ steps: 450_000, inputs: [] }).ok, true);
  assert.equal(parseGameLog({ steps: 5, inputs: [5, 9], garbage: [0, 1, 5, 2] }).ok, true);
});

test('a 200000-pair log within the body cap parses', () => {
  const inputs: number[] = [];
  for (let i = 0; i < 200_000; i++) inputs.push(2, 9);
  const wire = { steps: 450_000, inputs };
  assert.ok(Buffer.byteLength(JSON.stringify({ gameId: 'a'.repeat(64), log: wire })) <= 1_572_864);
  const r = parseGameLog(wire);
  assert.equal(r.ok, true);
  const v = (r as { ok: true; value: { inputs: [number, string][] } }).value;
  assert.equal(v.inputs.length, 200_000);
  assert.deepEqual(v.inputs.at(-1), [400_000, 'hold']);
});

test('encodeLog writes the compact form parseGameLog reads', () => {
  const decoded = { steps: 20, inputs: [[0, 'left'], [10, 'hardDrop'], [10, 'hold']] as [number, Input][], garbage: [[3, 1], [7, 2]] as [number, number][] };
  assert.deepEqual(encodeLog(decoded), { steps: 20, inputs: [0, 0, 10, 5, 0, 9], garbage: [3, 1, 4, 2] });
  assert.deepEqual(encodeLog({ steps: 3, inputs: [] }), { steps: 3, inputs: [] });
  assert.deepEqual(parseGameLog(encodeLog(decoded)), { ok: true, value: decoded });
});

test('parseGameLog rejections', () => {
  bad(parseGameLog(null), 'log must be an object');
  bad(parseGameLog({ inputs: [] }), 'steps must be an integer from 1 to 450000');
  bad(parseGameLog({ steps: 0, inputs: [] }), 'steps must be an integer from 1 to 450000');
  bad(parseGameLog({ steps: 1.5, inputs: [] }), 'steps must be an integer from 1 to 450000');
  bad(parseGameLog({ steps: 450_001, inputs: [] }), 'steps must be an integer from 1 to 450000');
  bad(parseGameLog({ steps: 10 }), 'inputs must be an array of at most 200000 [stepDelta, code] pairs');
  bad(parseGameLog({ steps: 10, inputs: new Array(400_002).fill(0) }), 'inputs must be an array of at most 200000 [stepDelta, code] pairs');
  bad(parseGameLog({ steps: 10, inputs: [5] }), 'inputs must be an array of at most 200000 [stepDelta, code] pairs');
  bad(parseGameLog({ steps: 10, inputs: [[0], 0] }), 'input step deltas must be integers of 0 or more');
  bad(parseGameLog({ steps: 10, inputs: [-1, 0] }), 'input step deltas must be integers of 0 or more');
  bad(parseGameLog({ steps: 10, inputs: [1.5, 0] }), 'input step deltas must be integers of 0 or more');
  bad(parseGameLog({ steps: 10, inputs: [11, 0] }), 'input steps must be from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [6, 0, 5, 1] }), 'input steps must be from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [0, 10] }), 'input codes must be integers from 0 to 9');
  bad(parseGameLog({ steps: 10, inputs: [0, -1] }), 'input codes must be integers from 0 to 9');
  bad(parseGameLog({ steps: 10, inputs: [0, 'left'] }), 'input codes must be integers from 0 to 9');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: 'x' }), 'garbage must be an array of at most 10000 [stepDelta, attackId] pairs');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: new Array(20_002).fill(1) }), 'garbage must be an array of at most 10000 [stepDelta, attackId] pairs');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [1] }), 'garbage must be an array of at most 10000 [stepDelta, attackId] pairs');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [-1, 1] }), 'garbage step deltas must be integers of 0 or more');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [11, 1] }), 'garbage steps must be from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [0, 0] }), 'garbage attackId must be a positive integer');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [0, 1.5] }), 'garbage attackId must be a positive integer');
});

test('parseScoreBody accepts and rejects', () => {
  const r = parseScoreBody({ gameId: 'abc_DEF-123', log });
  assert.equal(r.ok, true);
  bad(parseScoreBody(null), 'body must be an object');
  bad(parseScoreBody({ log }), 'gameId must be 1 to 64 letters, digits, - or _');
  bad(parseScoreBody({ gameId: 'a b', log }), 'gameId must be 1 to 64 letters, digits, - or _');
  bad(parseScoreBody({ gameId: 'a'.repeat(65), log }), 'gameId must be 1 to 64 letters, digits, - or _');
  bad(parseScoreBody({ gameId: 'abc', log: { steps: 0, inputs: [] } }), 'steps must be an integer from 1 to 450000');
});

test('parseLogBody accepts and rejects', () => {
  assert.equal(parseLogBody({ log }).ok, true);
  bad(parseLogBody([]), 'body must be an object');
  bad(parseLogBody({ log: 3 }), 'log must be an object');
});

const sync = { seq: 0, attacks: [1, 40], snapshot: '..IOTSZJLG', isOver: false };

test('parseSyncBody accepts valid bodies', () => {
  assert.equal(parseSyncBody(sync).ok, true);
  assert.equal(parseSyncBody({ seq: 9, attacks: [], snapshot: '', isOver: true }).ok, true);
  assert.equal(parseSyncBody({ ...sync, attacks: new Array(20).fill(1), snapshot: '.'.repeat(400) }).ok, true);
});

test('parseSyncBody rejections', () => {
  bad(parseSyncBody(undefined), 'body must be an object');
  bad(parseSyncBody({ ...sync, seq: -1 }), 'seq must be an integer of 0 or more');
  bad(parseSyncBody({ ...sync, seq: 1.5 }), 'seq must be an integer of 0 or more');
  bad(parseSyncBody({ ...sync, seq: '1' }), 'seq must be an integer of 0 or more');
  bad(parseSyncBody({ ...sync, attacks: 'x' }), 'attacks must be up to 20 integers from 1 to 40');
  bad(parseSyncBody({ ...sync, attacks: new Array(21).fill(1) }), 'attacks must be up to 20 integers from 1 to 40');
  bad(parseSyncBody({ ...sync, attacks: [0] }), 'attacks must be up to 20 integers from 1 to 40');
  bad(parseSyncBody({ ...sync, attacks: [41] }), 'attacks must be up to 20 integers from 1 to 40');
  bad(parseSyncBody({ ...sync, attacks: [1.5] }), 'attacks must be up to 20 integers from 1 to 40');
  bad(parseSyncBody({ ...sync, snapshot: 5 }), 'snapshot must be up to 400 board characters');
  bad(parseSyncBody({ ...sync, snapshot: '.'.repeat(401) }), 'snapshot must be up to 400 board characters');
  bad(parseSyncBody({ ...sync, snapshot: 'X' }), 'snapshot must be up to 400 board characters');
  bad(parseSyncBody({ ...sync, isOver: 'no' }), 'isOver must be a boolean');
});

const keys = (v: object) => Object.keys(v).sort();

test('LeaderboardReply rows carry the fields the client reads', () => {
  const reply: LeaderboardReply = {
    marathon: [{ login: 'a', score: 1, lines: 2, level: 3, at: 1700000000000 }],
    wins: [{ login: 'a', wins: 1 }],
    bot: { easy: [{ login: 'a', ms: 16, at: 1700000000000 }], medium: [], hard: [] },
  };
  const json = JSON.parse(JSON.stringify(reply));
  assert.deepEqual(keys(json), ['bot', 'marathon', 'wins']);
  assert.deepEqual(keys(json.bot), ['easy', 'hard', 'medium']);
  assert.deepEqual(keys(json.bot.easy[0]), ['at', 'login', 'ms']);
  assert.deepEqual(keys(json.marathon[0]), ['at', 'level', 'lines', 'login', 'score']);
  assert.deepEqual(keys(json.wins[0]), ['login', 'wins']);
});

test('SyncReply carries opponent login and incoming ids', () => {
  const reply: SyncReply = {
    opponent: { login: 'b', snapshot: '..I', isOver: false },
    incoming: [{ id: 1, lines: 4 }],
    result: { winner: 'b' },
  };
  const json = JSON.parse(JSON.stringify(reply));
  assert.deepEqual(keys(json), ['incoming', 'opponent', 'result']);
  assert.deepEqual(keys(json.opponent), ['isOver', 'login', 'snapshot']);
  assert.deepEqual(keys(json.incoming[0]), ['id', 'lines']);
  assert.deepEqual(keys(json.result), ['winner']);
  const none: SyncReply = { opponent: null, incoming: [] };
  assert.equal(JSON.parse(JSON.stringify(none)).opponent, null);
});

test('QueueReply, ConfigReply and SessionReply shapes', () => {
  const online = { playing: 2, looking: 1 };
  const waiting: QueueReply = { status: 'waiting', online };
  const matched: QueueReply = { status: 'matched', roomId: 'r1', seed: 5, opponent: { login: 'b' }, online };
  assert.deepEqual(keys(waiting), ['online', 'status']);
  assert.deepEqual(keys(matched), ['online', 'opponent', 'roomId', 'seed', 'status']);
  assert.deepEqual(keys(waiting.online), ['looking', 'playing']);
  assert.deepEqual(keys((matched as { opponent: object }).opponent), ['login']);
  const config: ConfigReply = { githubClientId: 'x', protocol: 3, protocols: { 'block-battle': 3, 'daily-diff': 1 } };
  assert.deepEqual(keys(config), ['githubClientId', 'protocol', 'protocols']);
  const session: SessionReply = { session: 's', login: 'a' };
  assert.deepEqual(keys(session), ['login', 'session']);
});
