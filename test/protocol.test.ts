import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_NAMES,
  PROTOCOL_VERSION,
  parseGameLog,
  parseLogBody,
  parseScoreBody,
  parseSessionBody,
  parseSyncBody,
} from '../src/protocol.ts';

function bad(r: { ok: boolean }, error?: string) {
  assert.equal(r.ok, false);
  const e = r as { ok: false; status: number; error: string };
  assert.equal(e.status, 400);
  if (error) assert.equal(e.error, error);
}

test('protocol version is 2', () => {
  assert.equal(PROTOCOL_VERSION, 2);
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

const log = { steps: 100, inputs: [[0, 'left'], [10, 'hardDrop']] };

test('parseGameLog accepts valid logs', () => {
  assert.equal(parseGameLog(log).ok, true);
  assert.equal(parseGameLog({ steps: 6_750_000, inputs: [] }).ok, true);
  assert.equal(parseGameLog({ steps: 5, inputs: [[5, 'hold']], garbage: [[0, 1], [5, 2]] }).ok, true);
});

test('parseGameLog rejections', () => {
  bad(parseGameLog(null), 'log must be an object');
  bad(parseGameLog({ inputs: [] }), 'steps must be an integer from 1 to 6750000');
  bad(parseGameLog({ steps: 0, inputs: [] }), 'steps must be an integer from 1 to 6750000');
  bad(parseGameLog({ steps: 1.5, inputs: [] }), 'steps must be an integer from 1 to 6750000');
  bad(parseGameLog({ steps: 6_750_001, inputs: [] }), 'steps must be an integer from 1 to 6750000');
  bad(parseGameLog({ steps: 10 }), 'inputs must be an array of at most 200000 entries');
  bad(parseGameLog({ steps: 10, inputs: new Array(200_001).fill([0, 'left']) }), 'inputs must be an array of at most 200000 entries');
  bad(parseGameLog({ steps: 10, inputs: [5] }), 'inputs entries must be [step, input] pairs');
  bad(parseGameLog({ steps: 10, inputs: [[0, 'left', 1]] }), 'inputs entries must be [step, input] pairs');
  bad(parseGameLog({ steps: 10, inputs: [[-1, 'left']] }), 'input steps must be integers from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [[11, 'left']] }), 'input steps must be integers from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [[1.5, 'left']] }), 'input steps must be integers from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [[3, 'left'], [2, 'right']] }), 'input steps must not decrease');
  bad(parseGameLog({ steps: 10, inputs: [[0, 'jump']] }), 'unknown input name');
  bad(parseGameLog({ steps: 10, inputs: [[0, 7]] }), 'unknown input name');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: 'x' }), 'garbage must be an array of at most 10000 entries');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: new Array(10_001).fill([0, 1]) }), 'garbage must be an array of at most 10000 entries');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [1] }), 'garbage entries must be [step, attackId] pairs');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [[11, 1]] }), 'garbage steps must be integers from 0 to steps');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [[3, 1], [2, 2]] }), 'garbage steps must not decrease');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [[0, 0]] }), 'garbage attackId must be a positive integer');
  bad(parseGameLog({ steps: 10, inputs: [], garbage: [[0, 1.5]] }), 'garbage attackId must be a positive integer');
});

test('parseScoreBody accepts and rejects', () => {
  const r = parseScoreBody({ gameId: 'abc_DEF-123', log });
  assert.equal(r.ok, true);
  bad(parseScoreBody(null), 'body must be an object');
  bad(parseScoreBody({ log }), 'gameId must be 1 to 64 letters, digits, - or _');
  bad(parseScoreBody({ gameId: 'a b', log }), 'gameId must be 1 to 64 letters, digits, - or _');
  bad(parseScoreBody({ gameId: 'a'.repeat(65), log }), 'gameId must be 1 to 64 letters, digits, - or _');
  bad(parseScoreBody({ gameId: 'abc', log: { steps: 0, inputs: [] } }), 'steps must be an integer from 1 to 6750000');
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
