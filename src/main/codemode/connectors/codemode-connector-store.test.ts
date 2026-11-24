import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodemodeConnectorStore } from './codemode-connector-store'

const URL_OK = 'https://mcp.example.com/mcp'
let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codemode-connectors-'))
  path = join(dir, 'codemode-connectors.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('CodemodeConnectorStore', () => {
  it('round trips through the file', async () => {
    const store = await CodemodeConnectorStore.open(path)
    const added = store.add({ name: 'fcu', url: URL_OK, auth: 'oauth' })
    expect(added).toMatchObject({ name: 'fcu', trusted: false, enabled: true, auth: 'oauth' })
    const reopened = await CodemodeConnectorStore.open(path)
    expect(reopened.list()).toEqual([added])
    expect(reopened.get(added.id)).toEqual(added)
    expect(reopened.byName('fcu')).toEqual(added)
    expect(reopened.byName('nope')).toBeNull()
  })

  it('validates names', async () => {
    const store = await CodemodeConnectorStore.open(path)
    const add = (name: string) => store.add({ name, url: URL_OK, auth: 'none' })
    expect(() => add('Fcu')).toThrow()
    expect(() => add('orca')).toThrow()
    expect(() => add('list')).toThrow()
    expect(() => add('a'.repeat(41))).toThrow()
    expect(add('a'.repeat(40)).name).toHaveLength(40)
    expect(add('fcu').name).toBe('fcu')
    expect(() => add('fcu')).toThrow('name taken: fcu')
  })

  it('validates urls', async () => {
    const store = await CodemodeConnectorStore.open(path)
    expect(() => store.add({ name: 'a', url: 'http://example.com/mcp', auth: 'none' })).toThrow()
    expect(() => store.add({ name: 'a', url: 'not a url', auth: 'none' })).toThrow()
    expect(store.add({ name: 'a', url: 'http://127.0.0.1:9/mcp', auth: 'none' }).name).toBe('a')
    expect(store.add({ name: 'b', url: 'http://localhost:9/mcp', auth: 'none' }).name).toBe('b')
  })

  it('update re-validates a rename and patches flags', async () => {
    const store = await CodemodeConnectorStore.open(path)
    const a = store.add({ name: 'a', url: URL_OK, auth: 'none' })
    store.add({ name: 'b', url: URL_OK, auth: 'none' })
    expect(() => store.update(a.id, { name: 'b' })).toThrow('name taken: b')
    expect(() => store.update(a.id, { name: 'orca' })).toThrow()
    expect(store.update(a.id, { name: 'c', trusted: true, enabled: false })).toMatchObject({
      name: 'c',
      trusted: true,
      enabled: false
    })
    expect(store.update(a.id, { trusted: false }).name).toBe('c')
  })

  it('remove returns the removed entry', async () => {
    const store = await CodemodeConnectorStore.open(path)
    const a = store.add({ name: 'a', url: URL_OK, auth: 'none' })
    expect(store.remove(a.id)).toEqual(a)
    expect(store.remove(a.id)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('writes only connector keys', async () => {
    const store = await CodemodeConnectorStore.open(path)
    store.add({ name: 'a', url: URL_OK, auth: 'token' })
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(file.version).toBe(1)
    expect(Object.keys(file.connectors[0]).sort()).toEqual(
      ['auth', 'enabled', 'id', 'name', 'trusted', 'url'].sort()
    )
  })

  it('treats a corrupt file as empty and keeps a copy', async () => {
    writeFileSync(path, '{not json')
    const store = await CodemodeConnectorStore.open(path)
    expect(store.list()).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe('{not json')
    store.add({ name: 'a', url: URL_OK, auth: 'none' })
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{not json')
    expect(existsSync(path)).toBe(true)
  })

  it('notifies on add, update and remove', async () => {
    const store = await CodemodeConnectorStore.open(path)
    const listener = vi.fn()
    const off = store.onChange(listener)
    const a = store.add({ name: 'a', url: URL_OK, auth: 'none' })
    store.update(a.id, { enabled: false })
    store.remove(a.id)
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    store.add({ name: 'b', url: URL_OK, auth: 'none' })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
