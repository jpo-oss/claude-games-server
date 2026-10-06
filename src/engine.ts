export type Kind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'
export type Cell = Kind | 'G' | null
export type Mode = 'marathon' | 'battle'
export type Input =
  | 'left' | 'right' | 'softDropOn' | 'softDropOff' | 'softDropStep' | 'hardDrop'
  | 'rotateCW' | 'rotateCCW' | 'rotate180' | 'hold'
export type ClearKind = 'single' | 'double' | 'triple' | 'quad'
  | 'tspinMini' | 'tspinMiniSingle' | 'tspinMiniDouble'
  | 'tspin' | 'tspinSingle' | 'tspinDouble' | 'tspinTriple'
export type GameEvent =
  | { type: 'lineClear'; rows: number[]; kind: ClearKind; b2b: boolean; combo: number; perfectClear: boolean; attack: number }
  | { type: 'lock' }
  | { type: 'hardDrop'; from: number; to: number; columns: number[] }
  | { type: 'hold' }
  | { type: 'garbageIn'; lines: number }
  | { type: 'levelUp'; level: number }
  | { type: 'topOut' }
export type Active = { kind: Kind; rotation: 0 | 1 | 2 | 3; x: number; y: number }
export type Game = {
  mode: Mode; seed: number; board: Cell[][]; active: Active | null; hold: Kind | null; canHold: boolean
  next: Kind[]; score: number; lines: number; level: number; combo: number; b2b: boolean
  pendingGarbage: { lines: number; hole: number }[]; isOver: boolean; elapsedMs: number
  rng: number; bag: Kind[]; garbageCount: number
  gravityMs: number; lockMs: number; resets: number; lowestY: number
  softDrop: boolean; rotated: boolean; kickIdx: number
}

const W = 10
const H = 40
const VISIBLE_TOP = 20
const LOCK_MS = 500
const MAX_RESETS = 15
const MAX_LEVEL = 15
const KINDS: Kind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

type Pt = readonly [number, number]
const BASE: Record<Kind, Pt[]> = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
}
const SHAPES = {} as Record<Kind, Pt[][]>
for (const k of KINDS) {
  const n = k === 'I' || k === 'O' ? 4 : 3
  const rots: Pt[][] = [BASE[k]]
  for (let r = 1; r < 4; r++) {
    rots.push(k === 'O' ? BASE[k] : rots[r - 1]!.map(([x, y]) => [n - 1 - y, x] as Pt))
  }
  SHAPES[k] = rots
}

// Offsets are (dx, dy) with y pointing up, as published; applied as y - dy.
const KICK_JLSTZ: Record<string, Pt[]> = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
}
const KICK_I: Record<string, Pt[]> = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
}
// Not guideline: the common SRS+ style 180 kicks, shared by all pieces.
const KICK_180: Record<string, Pt[]> = {
  '02': [[0, 0], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]],
  '20': [[0, 0], [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0]],
  '13': [[0, 0], [1, 0], [1, 2], [1, 1], [0, 2], [0, 1]],
  '31': [[0, 0], [-1, 0], [-1, 2], [-1, 1], [0, 2], [0, 1]],
}

const LINE_SCORE: Record<ClearKind, number> = {
  single: 100, double: 300, triple: 500, quad: 800,
  tspinMini: 100, tspinMiniSingle: 200, tspinMiniDouble: 400,
  tspin: 400, tspinSingle: 800, tspinDouble: 1200, tspinTriple: 1600,
}
const LINE_ATTACK: Record<ClearKind, number> = {
  single: 0, double: 1, triple: 2, quad: 4,
  tspinMini: 0, tspinMiniSingle: 0, tspinMiniDouble: 1,
  tspin: 0, tspinSingle: 2, tspinDouble: 4, tspinTriple: 6,
}
const COMBO_ATTACK = [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5]
const PC_SCORE = [0, 800, 1200, 1800, 2000]
const PC_B2B_QUAD = 3200
const PC_ATTACK = 10

function mix(s: number): number {
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function rand(g: Game): number {
  g.rng = (g.rng + 0x6d2b79f5) | 0
  return mix(g.rng)
}

function draw(g: Game): Kind {
  if (g.bag.length === 0) {
    const bag = KINDS.slice()
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand(g) * (i + 1))
      const t = bag[i]!
      bag[i] = bag[j]!
      bag[j] = t
    }
    g.bag = bag
  }
  return g.bag.pop()!
}

function clone(g: Game): Game {
  return {
    ...g,
    board: g.board.map(r => r.slice()),
    active: g.active && { ...g.active },
    next: g.next.slice(),
    bag: g.bag.slice(),
    pendingGarbage: g.pendingGarbage.map(p => ({ ...p })),
  }
}

function emptyRow(): Cell[] {
  return new Array<Cell>(W).fill(null)
}

function collides(board: Cell[][], kind: Kind, rotation: number, x: number, y: number): boolean {
  for (const [cx, cy] of SHAPES[kind][rotation]!) {
    const px = x + cx
    const py = y + cy
    if (px < 0 || px >= W || py < 0 || py >= H || board[py]![px] != null) return true
  }
  return false
}

function grounded(g: Game): boolean {
  const a = g.active!
  return collides(g.board, a.kind, a.rotation, a.x, a.y + 1)
}

export function cellsOf(active: Active): [number, number][] {
  return SHAPES[active.kind][active.rotation]!.map(([cx, cy]) => [active.x + cx, active.y + cy])
}

export function ghostY(game: Game): number | null {
  const a = game.active
  if (!a) return null
  let y = a.y
  while (!collides(game.board, a.kind, a.rotation, a.x, y + 1)) y++
  return y
}

export function newGame(mode: Mode, seed: number): Game {
  const g: Game = {
    mode, seed, board: Array.from({ length: H }, emptyRow), active: null, hold: null, canHold: true,
    next: [], score: 0, lines: 0, level: 1, combo: -1, b2b: false,
    pendingGarbage: [], isOver: false, elapsedMs: 0,
    rng: seed | 0, bag: [], garbageCount: 0,
    gravityMs: 0, lockMs: 0, resets: 0, lowestY: 0,
    softDrop: false, rotated: false, kickIdx: 0,
  }
  const first = draw(g)
  for (let i = 0; i < 5; i++) g.next.push(draw(g))
  spawn(g, first, [])
  return g
}

function topOut(g: Game, events: GameEvent[]) {
  g.isOver = true
  g.active = null
  events.push({ type: 'topOut' })
}

function spawn(g: Game, kind: Kind, events: GameEvent[]) {
  let y = 18
  if (collides(g.board, kind, 0, 3, y)) {
    g.active = null
    topOut(g, events)
    return
  }
  if (!collides(g.board, kind, 0, 3, y + 1)) y++
  g.active = { kind, rotation: 0, x: 3, y }
  g.rotated = false
  g.kickIdx = 0
  g.lockMs = 0
  g.resets = 0
  g.gravityMs = 0
  g.lowestY = y
}

function nextPiece(g: Game, events: GameEvent[]) {
  const kind = g.next.shift()!
  g.next.push(draw(g))
  spawn(g, kind, events)
}

function afterMove(g: Game, wasGrounded: boolean) {
  const a = g.active!
  if (a.y > g.lowestY) {
    g.lowestY = a.y
    g.resets = 0
  }
  if (!wasGrounded) return
  if (!grounded(g)) {
    g.lockMs = 0
  } else if (g.resets < MAX_RESETS) {
    g.lockMs = 0
    g.resets++
  }
}

function tryMove(g: Game, dx: number) {
  const a = g.active!
  if (collides(g.board, a.kind, a.rotation, a.x + dx, a.y)) return
  const was = grounded(g)
  a.x += dx
  g.rotated = false
  afterMove(g, was)
}

function rotate(g: Game, turn: 1 | 2 | 3) {
  const a = g.active!
  if (a.kind === 'O') return
  const to = ((a.rotation + turn) & 3) as 0 | 1 | 2 | 3
  const key = `${a.rotation}${to}`
  const list = turn === 2 ? KICK_180[key]! : (a.kind === 'I' ? KICK_I : KICK_JLSTZ)[key]!
  const was = grounded(g)
  for (let i = 0; i < list.length; i++) {
    const [dx, dy] = list[i]!
    if (collides(g.board, a.kind, to, a.x + dx, a.y - dy)) continue
    a.rotation = to
    a.x += dx
    a.y -= dy
    g.rotated = true
    g.kickIdx = turn === 2 ? 0 : i
    afterMove(g, was)
    return
  }
}

function stepDown(g: Game) {
  const a = g.active!
  a.y++
  g.rotated = false
  if (a.y > g.lowestY) {
    g.lowestY = a.y
    g.resets = 0
  }
}

function pushGarbage(g: Game, lines: number, hole: number): boolean {
  const lost = g.board.slice(0, lines).some(r => r.some(c => c != null))
  const rows: Cell[][] = []
  for (let i = 0; i < lines; i++) rows.push(Array.from({ length: W }, (_, c): Cell => (c === hole ? null : 'G')))
  g.board = g.board.slice(lines).concat(rows)
  return lost
}

function lockPiece(g: Game, events: GameEvent[]) {
  const a = g.active!
  const cells = cellsOf(a)
  let spin: 'none' | 'mini' | 'full' = 'none'
  if (a.kind === 'T' && g.rotated) {
    const filled = ([[0, 0], [2, 0], [0, 2], [2, 2]] as const).map(([cx, cy]) => {
      const x = a.x + cx
      const y = a.y + cy
      return x < 0 || x >= W || y < 0 || y >= H || g.board[y]![x] != null
    })
    if (filled.filter(Boolean).length >= 3) {
      const front = [[0, 1], [1, 3], [2, 3], [0, 2]][a.rotation]!
      spin = filled[front[0]!] && filled[front[1]!] || g.kickIdx === 4 ? 'full' : 'mini'
    }
  }
  for (const [x, y] of cells) g.board[y]![x] = a.kind
  g.active = null
  g.canHold = true
  events.push({ type: 'lock' })

  const rows: number[] = []
  for (let y = 0; y < H; y++) if (g.board[y]!.every(c => c != null)) rows.push(y)
  const n = rows.length

  if (n === 0 && cells.every(([, y]) => y < VISIBLE_TOP)) {
    topOut(g, events)
    return
  }

  if (n > 0) {
    g.board = g.board.filter((_, y) => !rows.includes(y))
    while (g.board.length < H) g.board.unshift(emptyRow())
  }

  const level = g.level
  let kind: ClearKind | null = null
  if (spin === 'none') kind = n === 0 ? null : (['single', 'double', 'triple', 'quad'] as const)[n - 1]!
  else if (spin === 'mini') kind = (['tspinMini', 'tspinMiniSingle', 'tspinMiniDouble', 'tspinTriple'] as const)[n]!
  else kind = (['tspin', 'tspinSingle', 'tspinDouble', 'tspinTriple'] as const)[n]!

  let attack = 0
  if (kind) {
    const difficult = n > 0 && (kind === 'quad' || spin !== 'none')
    const b2bApplied = difficult && g.b2b
    let points = Math.floor(LINE_SCORE[kind] * level * (b2bApplied ? 1.5 : 1))
    let perfect = false
    if (n > 0) {
      g.combo++
      points += 50 * g.combo * level
      perfect = g.board.every(r => r.every(c => c == null))
      if (perfect) points += (n === 4 && b2bApplied ? PC_B2B_QUAD : PC_SCORE[n]!) * level
      g.b2b = difficult
      if (g.mode === 'battle') {
        attack = perfect
          ? PC_ATTACK
          : LINE_ATTACK[kind] + (b2bApplied ? 1 : 0) + COMBO_ATTACK[Math.min(g.combo, COMBO_ATTACK.length - 1)]!
        while (attack > 0 && g.pendingGarbage.length > 0) {
          const p = g.pendingGarbage[0]!
          if (p.lines <= attack) {
            attack -= p.lines
            g.pendingGarbage.shift()
          } else {
            p.lines -= attack
            attack = 0
          }
        }
      }
    } else {
      g.combo = -1
    }
    g.score += points
    events.push({ type: 'lineClear', rows, kind, b2b: b2bApplied, combo: g.combo, perfectClear: perfect, attack })
  } else {
    g.combo = -1
  }

  if (n > 0) {
    g.lines += n
    const lv = Math.min(MAX_LEVEL, 1 + Math.floor(g.lines / 10))
    if (lv > g.level) {
      g.level = lv
      events.push({ type: 'levelUp', level: lv })
    }
  } else if (g.pendingGarbage.length > 0) {
    let total = 0
    let lost = false
    for (const p of g.pendingGarbage) {
      total += p.lines
      if (pushGarbage(g, p.lines, p.hole)) lost = true
    }
    g.pendingGarbage = []
    events.push({ type: 'garbageIn', lines: total })
    if (lost) {
      topOut(g, events)
      return
    }
  }
  nextPiece(g, events)
}

function gravityMs(level: number): number {
  return 1000 * Math.pow(0.8 - (level - 1) * 0.007, level - 1)
}

function advance(g: Game, dt: number, events: GameEvent[]) {
  let rem = dt
  for (let guard = 0; rem > 0 && g.active && !g.isOver && guard < 1000; guard++) {
    if (grounded(g)) {
      g.gravityMs = 0
      const need = LOCK_MS - g.lockMs
      if (rem >= need) {
        rem -= need
        lockPiece(g, events)
      } else {
        g.lockMs += rem
        rem = 0
      }
      continue
    }
    g.lockMs = 0
    const iv = gravityMs(g.level) / (g.softDrop ? 20 : 1)
    g.gravityMs += rem
    rem = 0
    while (g.gravityMs >= iv && !grounded(g)) {
      stepDown(g)
      g.gravityMs -= iv
      if (g.softDrop) g.score++
    }
    if (grounded(g)) {
      rem = g.gravityMs
      g.gravityMs = 0
    }
  }
}

function apply(g: Game, input: Input, events: GameEvent[]) {
  const a = g.active!
  switch (input) {
    case 'left': return tryMove(g, -1)
    case 'right': return tryMove(g, 1)
    case 'softDropOn': g.softDrop = true; return
    case 'softDropOff': g.softDrop = false; return
    case 'softDropStep':
      if (!grounded(g)) {
        stepDown(g)
        g.score++
        g.gravityMs = 0
      }
      return
    case 'rotateCW': return rotate(g, 1)
    case 'rotateCCW': return rotate(g, 3)
    case 'rotate180': return rotate(g, 2)
    case 'hardDrop': {
      const from = a.y
      while (!grounded(g)) {
        a.y++
        g.score += 2
      }
      if (a.y !== from) g.rotated = false
      const columns = [...new Set(cellsOf(a).map(([x]) => x))].sort((p, q) => p - q)
      events.push({ type: 'hardDrop', from, to: a.y, columns })
      lockPiece(g, events)
      return
    }
    case 'hold': {
      if (!g.canHold) return
      const cur = a.kind
      g.canHold = false
      events.push({ type: 'hold' })
      if (g.hold === null) {
        g.hold = cur
        nextPiece(g, events)
      } else {
        const h = g.hold
        g.hold = cur
        spawn(g, h, events)
      }
      return
    }
  }
}

export function step(game: Game, inputs: Input[], dtMs: number): { game: Game; events: GameEvent[] } {
  if (game.isOver) return { game, events: [] }
  const g = clone(game)
  const events: GameEvent[] = []
  for (const input of inputs) {
    if (g.isOver || !g.active) break
    apply(g, input, events)
  }
  if (!g.isOver && dtMs > 0) advance(g, dtMs, events)
  g.elapsedMs += dtMs
  return { game: g, events }
}

export function receiveGarbage(game: Game, lines: number): Game {
  const g = clone(game)
  if (g.mode !== 'battle' || lines <= 0 || g.isOver) return g
  // Holes come from their own stream so garbage never shifts the 7-bag both players share.
  g.garbageCount++
  g.pendingGarbage.push({ lines, hole: Math.floor(mix((g.seed + Math.imul(g.garbageCount, 0x9e3779b9)) | 0) * W) })
  return g
}

// 20 visible rows of 10 chars, top row first, concatenated with no separator; the falling piece is included.
export function snapshot(game: Game): string {
  const rows = game.board.slice(VISIBLE_TOP).map(r => r.map(c => c ?? '.'))
  if (game.active) {
    for (const [x, y] of cellsOf(game.active)) if (y >= VISIBLE_TOP) rows[y - VISIBLE_TOP]![x] = game.active.kind
  }
  return rows.map(r => r.join('')).join('')
}
