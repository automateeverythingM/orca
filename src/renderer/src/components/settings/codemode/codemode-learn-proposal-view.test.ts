import { describe, expect, it } from 'vitest'
import type { CodemodeLearnProposal } from '../../../../../shared/codemode/codemode-learn-types'
import {
  canSaveProposal,
  defaultSaveScope,
  editedSource,
  proposeParams,
  splitProposals
} from './codemode-learn-proposal-view'

const proposal = (patch: Partial<CodemodeLearnProposal>): CodemodeLearnProposal => ({
  id: 'p',
  createdAt: 1,
  sourceKind: 'script',
  sourceKey: 'k',
  sourceSessions: 2,
  projectRoot: '/repo',
  state: 'ready',
  callsBefore: 3,
  ...patch
})

describe('splitProposals', () => {
  it('keeps open and saved apart, in order, and drops dismissed ones', () => {
    const list = [
      proposal({ id: 'a', state: 'writing' }),
      proposal({ id: 'b', state: 'saved' }),
      proposal({ id: 'c', state: 'dismissed' }),
      proposal({ id: 'd', state: 'failed' }),
      proposal({ id: 'e', state: 'testing' }),
      proposal({ id: 'f', state: 'ready' })
    ]
    const { open, saved } = splitProposals(list)
    expect(open.map((p) => p.id)).toEqual(['a', 'd', 'e', 'f'])
    expect(saved.map((p) => p.id)).toEqual(['b'])
  })
})

describe('canSaveProposal', () => {
  it('only a ready or failed proposal that has a function', () => {
    expect(canSaveProposal(proposal({ state: 'ready', source: 'x' }))).toBe(true)
    expect(canSaveProposal(proposal({ state: 'failed', source: 'x' }))).toBe(true)
    expect(canSaveProposal(proposal({ state: 'failed' }))).toBe(false)
    expect(canSaveProposal(proposal({ state: 'testing', source: 'x' }))).toBe(false)
    expect(canSaveProposal(proposal({ state: 'saved', source: 'x' }))).toBe(false)
  })
})

describe('defaultSaveScope', () => {
  it('the writer’s scope, but global when there is no project to save into', () => {
    expect(defaultSaveScope(proposal({ scope: 'project' }))).toBe('project')
    expect(defaultSaveScope(proposal({ scope: 'global' }))).toBe('global')
    expect(defaultSaveScope(proposal({}))).toBe('project')
    expect(defaultSaveScope(proposal({ scope: 'project', projectRoot: null }))).toBe('global')
  })
})

describe('editedSource', () => {
  it('only a real edit is sent', () => {
    const p = proposal({ source: 'function a() {}' })
    expect(editedSource(p, null)).toBeUndefined()
    expect(editedSource(p, 'function a() {}')).toBeUndefined()
    expect(editedSource(p, 'function a() { return 1 }')).toBe('function a() { return 1 }')
    expect(editedSource(p, '   ')).toBeUndefined()
  })
})

describe('proposeParams', () => {
  it('sends a trimmed hint, or nothing', () => {
    expect(proposeParams('')).toEqual({})
    expect(proposeParams('  \n ')).toEqual({})
    expect(proposeParams('  crm credits ')).toEqual({ hint: 'crm credits' })
    expect(proposeParams('x'.repeat(2500)).hint).toHaveLength(2000)
  })
})
