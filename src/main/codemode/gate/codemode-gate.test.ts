import { describe, expect, it } from 'vitest'
import { decideGate, type GateCall, type GateDecision, type GateMode } from './codemode-gate'

const MODES: GateMode[] = ['own', 'ask', 'accept-edits', 'auto', 'full-access', 'read-only']

const A = 'allow'
const Q = 'ask'
const P = 'ask-person-only'
const R = 'refuse'

// Order matches MODES: own, ask, accept-edits, auto, full-access, read-only.
const MATRIX: { name: string; call: GateCall; expected: GateDecision[] }[] = [
  { name: 'read', call: { kind: 'read' }, expected: [A, A, A, A, A, A] },
  { name: 'write', call: { kind: 'write' }, expected: [Q, Q, A, A, A, R] },
  { name: 'bash', call: { kind: 'bash' }, expected: [Q, Q, Q, Q, A, R] },
  {
    name: 'mcp untrusted',
    call: { kind: 'mcp', server: 's', trusted: false },
    expected: [Q, Q, Q, Q, A, R]
  },
  {
    name: 'mcp trusted',
    call: { kind: 'mcp', server: 's', trusted: true },
    expected: [A, A, A, A, A, R]
  },
  {
    name: 'mcp-start',
    call: { kind: 'mcp-start', server: 's' },
    expected: [P, P, P, P, A, R]
  },
  { name: 'path-outside', call: { kind: 'path-outside' }, expected: [R, R, Q, Q, Q, R] }
]

describe('decideGate', () => {
  for (const row of MATRIX) {
    it(`matches the spec matrix for ${row.name}`, () => {
      const actual = MODES.map((mode) => decideGate(row.call, mode))
      expect(actual).toEqual(row.expected)
    })
  }
})
