// The .ts extensions let the server run a byte-identical copy under Node.
import { cellsOf } from './engine.ts'
import type { Game, GameEvent, Input, Kind } from './engine.ts'

export type Level = 'easy' | 'medium' | 'hard'
export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard']

type Tuning = { pace: number; hold: boolean; lookahead: boolean; slip: number; slipTo: 'top5' | 'second' | 'none'; top: number }

// pace: steps between inputs. slip: pieces per thousand that take a worse placement.
// top: the engine level whose gravity the bot's board never goes past.
export const TUNING: Record<Level, Tuning> = {
  easy: { pace: 12, hold: false, lookahead: false, slip: 300, slipTo: 'top5', top: 5 },
  medium: { pace: 5, hold: true, lookahead: false, slip: 50, slipTo: 'second', top: 8 },
  hard: { pace: 3, hold: false, lookahead: true, slip: 0, slipTo: 'none', top: 10 },
}

// Placements scored per step, so a long think spreads over steps instead of stalling one.
export const SEARCH_PER_STEP = 64
const LOOKAHEAD_KEEP = 5
// From this level a piece is on the stack before it can shift, so plans must be reachable by sliding.
const FAST_LEVEL = 14

// Integer weights: integer arithmetic is exact on every JS engine, so the server agrees.
const W_HEIGHT = -510
const W_LINES = 761
const W_HOLES = -357
const W_BUMP = -184
const DEAD = -1_000_000_000

const H = 40
const W = 10
const FULL = (1 << W) - 1
const SPAWN_X = 3
const SPAWN_Y = 18
const VISIBLE_TOP = 20
const KINDS: readonly Kind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

// m[dy] is the piece's row dy as a bitmask of board columns; low is its lowest dy.
type Place = { x: number; m: number[]; low: number }
const PLACES = {} as Record<Kind, Place[][]>
for (const kind of KINDS) {
  PLACES[kind] = ([0, 1, 2, 3] as const).map(rotation => {
    const cells = cellsOf({ kind, rotation, x: 0, y: 0 })
    const xs = cells.map(([x]) => x)
    const low = Math.max(...cells.map(([, y]) => y))
    const out: Place[] = []
    for (let x = -Math.min(...xs); x + Math.max(...xs) < W; x++) {
      const m = [0, 0, 0, 0]
      for (const [cx, cy] of cells) m[cy] = m[cy]! | (1 << (x + cx))
      out.push({ x, m, low })
    }
    return out
  })
}

type Cand = { kind: Kind; hold: boolean; rot: number; place: Place }
type Scored = { c: Cand; score: number; rows: number[]; lines: number; i: number }
type Job = { parent: number; c: Cand }
type Think = { base: number[]; fast: boolean; jobs: Job[]; at: number; first: Scored[]; deep: number[]; stage: 1 | 2 }
type Plan = { hold: boolean; held: boolean; rot: number; x: number; rescued: boolean }

export type Bot = {
  level: Level
  rng: number
  wait: number
  think: Think | null
  plan: Plan | null
  last: { input: Input; x: number; rot: number } | null
}

export const newBot = (level: Level, seed: number): Bot => ({ level, rng: (seed ^ 0x2545f491) | 0, wait: 0, think: null, plan: null, last: null })

function rand32(b: Bot): number {
  b.rng = (b.rng + 0x6d2b79f5) | 0
  let t = Math.imul(b.rng ^ (b.rng >>> 15), 1 | b.rng)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (t ^ (t >>> 14)) >>> 0
}

function toRows(board: Game['board']): number[] {
  return board.map(r => {
    let m = 0
    for (let x = 0; x < W; x++) if (r[x] != null) m |= 1 << x
    return m
  })
}

function fits(rows: readonly number[], m: readonly number[], y: number): boolean {
  for (let dy = 0; dy < 4; dy++) {
    if (m[dy] === 0) continue
    const r = y + dy
    if (r >= H || (rows[r]! & m[dy]!) !== 0) return false
  }
  return true
}

// Straight down from the spawn row. dead: the engine would top out on this lock.
function land(rows: readonly number[], p: Place, from = SPAWN_Y): { rows: number[]; lines: number; dead: boolean } | null {
  let y = from
  if (!fits(rows, p.m, y)) return null
  while (fits(rows, p.m, y + 1)) y++
  const placed = rows.slice()
  for (let dy = 0; dy < 4; dy++) if (p.m[dy]) placed[y + dy] = placed[y + dy]! | p.m[dy]!
  const kept = placed.filter(r => r !== FULL)
  const lines = H - kept.length
  while (kept.length < H) kept.unshift(0)
  return { rows: kept, lines, dead: lines === 0 && y + p.low < VISIBLE_TOP }
}

// Turned at the spawn column, then moved one column at a time while resting on the stack.
function slides(rows: readonly number[], c: Cand): boolean {
  const list = PLACES[c.kind][c.rot]!
  const to = c.place.x - list[0]!.x
  let i = SPAWN_X - list[0]!.x
  let y = SPAWN_Y
  if (!fits(rows, list[i]!.m, y)) return false
  while (i !== to) {
    while (fits(rows, list[i]!.m, y + 1)) y++
    const n = i < to ? i + 1 : i - 1
    if (!fits(rows, list[n]!.m, y)) return false
    i = n
  }
  return true
}

function evaluate(rows: readonly number[], lines: number): number {
  let agg = 0
  let holes = 0
  let bump = 0
  let prev = -1
  for (let c = 0; c < W; c++) {
    const bit = 1 << c
    let top = H
    for (let y = 0; y < H; y++) {
      if (rows[y]! & bit) {
        top = y
        break
      }
    }
    for (let y = top + 1; y < H; y++) if (!(rows[y]! & bit)) holes++
    const h = H - top
    agg += h
    if (prev >= 0) bump += Math.abs(h - prev)
    prev = h
  }
  return W_HEIGHT * agg + W_LINES * lines + W_HOLES * holes + W_BUMP * bump
}

function candidates(kind: Kind, hold: boolean): Cand[] {
  const out: Cand[] = []
  for (let rot = 0; rot < (kind === 'O' ? 1 : 4); rot++) for (const place of PLACES[kind][rot]!) out.push({ kind, hold, rot, place })
  return out
}

function startThink(b: Bot, game: Game): Think {
  const a = game.active!
  const cands = candidates(a.kind, false)
  if (TUNING[b.level].hold && game.canHold) {
    const alt = game.hold ?? game.next[0]
    if (alt && alt !== a.kind) cands.push(...candidates(alt, true))
  }
  return { base: toRows(game.board), fast: game.level >= FAST_LEVEL, jobs: cands.map(c => ({ parent: -1, c })), at: 0, first: [], deep: [], stage: 1 }
}

function runJob(th: Think, job: Job) {
  if (job.parent < 0) {
    if (th.fast && !slides(th.base, job.c)) return
    const r = land(th.base, job.c.place)
    if (!r) return
    th.first.push({ c: job.c, score: r.dead ? DEAD : evaluate(r.rows, r.lines), rows: r.rows, lines: r.lines, i: th.first.length })
    return
  }
  const p = th.first[job.parent]!
  if (p.score === DEAD || (th.fast && !slides(p.rows, job.c))) return
  const r = land(p.rows, job.c.place)
  if (!r || r.dead) return
  const s = evaluate(r.rows, p.lines + r.lines)
  if (s > th.deep[job.parent]!) th.deep[job.parent] = s
}

function choose(b: Bot, th: Think, game: Game): Plan {
  let order = th.first
  if (th.stage === 2) {
    const k = Math.min(LOOKAHEAD_KEEP, order.length)
    const top = order
      .slice(0, k)
      .map((s, i) => ({ s, d: th.deep[i]!, i }))
      .sort((p, q) => q.d - p.d || p.i - q.i)
      .map(t => t.s)
    order = [...top, ...order.slice(k)]
  }
  const t = TUNING[b.level]
  const u1 = rand32(b)
  const u2 = rand32(b)
  let pick = 0
  if (order.length > 1 && u1 % 1000 < t.slip) pick = t.slipTo === 'second' ? 1 : u2 % Math.min(5, order.length)
  const c = order[pick]?.c
  const a = game.active!
  return c ? { hold: c.hold, held: false, rot: c.rot, x: c.place.x, rescued: false } : { hold: false, held: false, rot: a.rotation, x: a.x, rescued: true }
}

// True once a plan is ready.
function thinkStep(b: Bot, game: Game): boolean {
  const th = b.think ?? (b.think = startThink(b, game))
  for (let n = 0; n < SEARCH_PER_STEP && th.at < th.jobs.length; n++) runJob(th, th.jobs[th.at++]!)
  if (th.at < th.jobs.length) return false
  if (th.stage === 1) {
    th.first.sort((p, q) => q.score - p.score || p.i - q.i)
    const next = game.next[0]
    if (TUNING[b.level].lookahead && next) {
      th.stage = 2
      th.deep = th.first.map(() => DEAD)
      const k = Math.min(LOOKAHEAD_KEEP, th.first.length)
      for (let i = 0; i < k; i++) for (const c of candidates(next, false)) th.jobs.push({ parent: i, c })
      if (th.at < th.jobs.length) return false
    }
  }
  b.plan = choose(b, th, game)
  b.think = null
  return true
}

// Blocked on the way, usually by fast gravity: retarget to the best column the piece can still slide to.
function rescue(game: Game): Plan {
  const a = game.active!
  const rows = toRows(game.board)
  const list = PLACES[a.kind][a.rotation]!
  const at = a.x - list[0]!.x
  let best = at
  let bestScore = DEAD
  const consider = (i: number) => {
    const r = land(rows, list[i]!, a.y)
    const s = !r || r.dead ? DEAD : evaluate(r.rows, r.lines)
    if (s > bestScore) {
      best = i
      bestScore = s
    }
  }
  consider(at)
  for (let i = at - 1; i >= 0 && fits(rows, list[i]!.m, a.y); i--) consider(i)
  for (let i = at + 1; i < list.length && fits(rows, list[i]!.m, a.y); i++) consider(i)
  return { hold: false, held: false, rot: a.rotation, x: list[best]!.x, rescued: true }
}

const TURN: Record<number, Input> = { 1: 'rotateCW', 2: 'rotate180', 3: 'rotateCCW' }

// Steers the live piece toward the plan. A move or turn that changed nothing means it is blocked:
// the first time it retargets, after that it drops.
function nextInput(b: Bot, game: Game): Input {
  const a = game.active!
  const last = b.last
  const isStuck = last !== null && last.input !== 'hold' && last.x === a.x && last.rot === a.rotation
  const giveUp = isStuck && b.plan!.rescued
  if (isStuck && !giveUp) b.plan = rescue(game)
  const p = b.plan!
  let input: Input
  if (p.hold && !p.held && game.canHold) {
    input = 'hold'
    p.held = true
  } else if (giveUp || (a.rotation === p.rot && a.x === p.x)) input = 'hardDrop'
  else if (a.rotation !== p.rot) input = TURN[(p.rot - a.rotation) & 3]!
  else input = a.x < p.x ? 'right' : 'left'
  b.last = { input, x: a.x, rot: a.rotation }
  return input
}

export function botInputs(b: Bot, game: Game): Input[] {
  if (game.isOver || !game.active) return []
  if (b.wait > 0) b.wait--
  if (!b.plan && !thinkStep(b, game)) return []
  if (b.wait > 0) return []
  b.wait = TUNING[b.level].pace
  return [nextInput(b, game)]
}

// Without a top speed the bot's own line clears raise its level until pieces outrun its pace.
export const capSpeed = (b: Bot, game: Game): Game => (game.level > TUNING[b.level].top ? { ...game, level: TUNING[b.level].top } : game)

export function botSaw(b: Bot, events: readonly GameEvent[]): void {
  if (!events.some(e => e.type === 'lock' || e.type === 'topOut')) return
  b.plan = null
  b.think = null
  b.last = null
}
