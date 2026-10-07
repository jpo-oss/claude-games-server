import { newGame, receiveGarbage, step } from './engine.ts'
import type { Game, GameEvent, Input } from './engine.ts'
import { botStep, newBot } from './bot.ts'
import type { Bot, Level } from './bot.ts'

const STEP_MS = 16

export type Match = { me: Game; bot: Game; brain: Bot; steps: number; winner: 'me' | 'bot' | null }

export const newMatch = (seed: number, level: Level): Match => ({
  me: newGame('battle', seed),
  bot: newGame('battle', seed),
  brain: newBot(level, seed),
  steps: 0,
  winner: null,
})

export function stepMatch(m: Match, inputs: readonly Input[]): { me: GameEvent[]; bot: GameEvent[] } {
  if (m.winner) return { me: [], bot: [] }
  const a = step(m.me, [...inputs], STEP_MS)
  const b = botStep(m.brain, m.bot, STEP_MS)
  let me = a.game
  let bot = b.game
  for (const e of a.events) if (e.type === 'lineClear' && e.attack > 0) bot = receiveGarbage(bot, e.attack)
  for (const e of b.events) if (e.type === 'lineClear' && e.attack > 0) me = receiveGarbage(me, e.attack)
  m.me = me
  m.bot = bot
  m.steps++
  if (me.isOver) m.winner = 'bot'
  else if (bot.isOver) m.winner = 'me'

  return { me: a.events, bot: b.events }
}
