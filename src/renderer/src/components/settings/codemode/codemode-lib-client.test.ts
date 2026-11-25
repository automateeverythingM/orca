import { describe, expect, it } from 'vitest'
import { functionsProject } from './codemode-lib-client'

describe('functionsProject', () => {
  it('uses a local worktree as the project', () => {
    expect(functionsProject({ path: '/w/a' })).toEqual({ projectRoot: '/w/a', remote: false })
    expect(functionsProject({ path: '/w/a', hostId: 'local' })).toEqual({
      projectRoot: '/w/a',
      remote: false
    })
  })

  it('shows only global functions for a remote worktree or none', () => {
    for (const hostId of ['ssh:box', 'runtime:paired'] as const) {
      expect(functionsProject({ path: '/w/a', hostId })).toEqual({
        projectRoot: null,
        remote: true
      })
    }
    expect(functionsProject(null)).toEqual({ projectRoot: null, remote: false })
  })
})
