import { describe, expect, it } from 'vitest'
import type {
  CodemodeRepeatedChain,
  CodemodeRepeatedScript
} from '../../../shared/codemode/codemode-learn-types'
import { pickSignals } from './codemode-learn-rank'

const script = (
  shape: string,
  sessions: number,
  tools: number,
  lastSeen = 1
): CodemodeRepeatedScript => ({
  kind: 'script',
  shape,
  sessions,
  runs: sessions,
  lastSeen,
  sampleCode: '',
  tools: Array.from({ length: tools }, (_, i) => `t${i}`),
  projectRoots: []
})
const chain = (
  signature: string,
  sessions: number,
  tools: number,
  lastSeen = 1
): CodemodeRepeatedChain => ({
  kind: 'chain',
  signature,
  tools: Array.from({ length: tools }, (_, i) => `t${i}`),
  sessions,
  occurrences: sessions,
  lastSeen
})
const keys = (signals: ReturnType<typeof pickSignals>) =>
  signals.map((s) => (s.kind === 'script' ? s.script.shape : s.chain.signature))

describe('pickSignals', () => {
  it('orders by sessions x (tools - 1), chains at half', () => {
    const out = pickSignals(
      [script('a', 2, 3), script('b', 5, 2)], // 4, 5
      [chain('c', 4, 4), chain('d', 2, 2)], // 6, 1
      new Set()
    )
    expect(keys(out)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('breaks ties by lastSeen, newest first', () => {
    expect(
      keys(pickSignals([script('old', 2, 2, 1), script('new', 2, 2, 9)], [], new Set()))
    ).toEqual(['new', 'old'])
  })

  it('skips keys and caps at 5', () => {
    const scripts = Array.from({ length: 8 }, (_, i) => script(`s${i}`, 2 + i, 2))
    const out = pickSignals(scripts, [], new Set(['s7']))
    expect(out).toHaveLength(5)
    expect(keys(out)).toEqual(['s6', 's5', 's4', 's3', 's2'])
    expect(keys(pickSignals(scripts, [], new Set(), 2))).toEqual(['s7', 's6'])
  })
})
