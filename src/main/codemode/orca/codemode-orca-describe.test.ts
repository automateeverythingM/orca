import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { describeOrca } from './codemode-orca-describe'
import { OrcaMethodIndex } from './codemode-orca-method-index'

const index = OrcaMethodIndex.from(ALL_RPC_METHODS)

describe('describeOrca', () => {
  it('describes every method in an area with labels and object-or-null params', () => {
    const result = describeOrca(index, 'worktree')
    expect(result.length).toBeGreaterThan(0)
    for (const entry of result) {
      expect(entry.method.startsWith('worktree.')).toBe(true)
      expect(['read', 'write', 'destructive']).toContain(entry.label)
      if (entry.params !== null) {
        expect(entry.params).toMatchObject({ type: 'object' })
      }
    }
  })

  it('describes a single method by full name', () => {
    const result = describeOrca(index, 'worktree.create')
    expect(result).toHaveLength(1)
    expect(result[0]?.method).toBe('worktree.create')
  })

  it('throws for an unknown target', () => {
    expect(() => describeOrca(index, 'nope.nothing')).toThrow(
      'unknown Orca area or method: nope.nothing'
    )
  })

  it.each(['codemode', 'codemode.connectors.setToken', 'codemode.lib.delete'])(
    'does not describe code mode itself: %s',
    (target) => {
      const registered = ALL_RPC_METHODS.map((method) => method.name)
      expect(registered.some((name) => name === target || name.startsWith(`${target}.`))).toBe(true)
      expect(() => describeOrca(index, target)).toThrow(`unknown Orca area or method: ${target}`)
    }
  )

  it('caches converted schemas per method', () => {
    const first = describeOrca(index, 'worktree.create')[0]
    const second = describeOrca(index, 'worktree.create')[0]
    expect(first?.params).not.toBeNull()
    expect(second?.params).toBe(first?.params)
  })

  it('serializes a large area to valid JSON', () => {
    const result = describeOrca(index, 'browser')
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(10)
    expect(Array.isArray(JSON.parse(JSON.stringify(result)))).toBe(true)
  })

  it('yields a placeholder when a schema cannot be converted', () => {
    const broken = z.lazy(() => {
      throw new Error('boom')
    })
    const custom = OrcaMethodIndex.from([
      { name: 'worktree.broken', permission: 'workspace', params: broken }
    ])
    expect(describeOrca(custom, 'worktree.broken')[0]?.params).toEqual({
      description: 'schema unavailable'
    })
  })
})
