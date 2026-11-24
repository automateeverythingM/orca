import { copyFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import {
  CODEMODE_CONNECTOR_NAME,
  CODEMODE_RESERVED_NAMES,
  type CodemodeConnector,
  type CodemodeConnectorAuth
} from '../../../shared/codemode/codemode-connector-types'
import { newBotToolCredentialId } from '../../bots/bot-tool-credentials'

export const CODEMODE_CONNECTOR_CREDENTIAL_FOLDER = join(homedir(), '.orca', 'codemode-connectors')

const AUTH_KINDS: readonly string[] = ['oauth', 'token', 'none']
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

function defaultStorePath(): string {
  return join(homedir(), '.orca', 'codemode-connectors.json')
}

function isConnector(value: unknown): value is CodemodeConnector {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.url === 'string' &&
    typeof v.auth === 'string' &&
    AUTH_KINDS.includes(v.auth) &&
    typeof v.trusted === 'boolean' &&
    typeof v.enabled === 'boolean'
  )
}

function parseConnectors(text: string): CodemodeConnector[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const list =
      typeof parsed === 'object' && parsed !== null && 'connectors' in parsed
        ? parsed.connectors
        : undefined
    if (!Array.isArray(list) || !list.every(isConnector)) {
      return null
    }
    return list.map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      auth: c.auth,
      trusted: c.trusted,
      enabled: c.enabled
    }))
  } catch {
    return null
  }
}

function assertUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`invalid url: ${url}`)
  }
  const localAllowed =
    process.env.NODE_ENV === 'test' &&
    parsed.protocol === 'http:' &&
    LOCAL_HOSTS.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !localAllowed) {
    throw new Error(`connector url must use https: ${url}`)
  }
}

export class CodemodeConnectorStore {
  private connectors: CodemodeConnector[]
  private readonly listeners = new Set<() => void>()

  private constructor(
    private readonly path: string,
    connectors: CodemodeConnector[]
  ) {
    this.connectors = connectors
  }

  // Loaded once, asynchronously; every later read is served from memory.
  static async open(path: string = defaultStorePath()): Promise<CodemodeConnectorStore> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // Why: only a missing file means no connectors; opening empty on any other error would let
      // the next write wipe the list.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return new CodemodeConnectorStore(path, [])
      }
      throw error
    }
    const connectors = parseConnectors(text)
    if (connectors) {
      return new CodemodeConnectorStore(path, connectors)
    }
    await copyFile(path, `${path}.corrupt`).catch(() => {})
    return new CodemodeConnectorStore(path, [])
  }

  list(): CodemodeConnector[] {
    return this.connectors.map((c) => ({ ...c }))
  }

  get(id: string): CodemodeConnector | null {
    const found = this.connectors.find((c) => c.id === id)
    return found ? { ...found } : null
  }

  byName(name: string): CodemodeConnector | null {
    const found = this.connectors.find((c) => c.name === name)
    return found ? { ...found } : null
  }

  add(input: { name: string; url: string; auth: CodemodeConnectorAuth }): CodemodeConnector {
    this.assertName(input.name)
    assertUrl(input.url)
    if (!AUTH_KINDS.includes(input.auth)) {
      throw new Error(`invalid auth: ${String(input.auth)}`)
    }
    const connector: CodemodeConnector = {
      id: newBotToolCredentialId(),
      name: input.name,
      url: input.url,
      auth: input.auth,
      trusted: false,
      enabled: true
    }
    this.commit([...this.connectors, connector])
    return { ...connector }
  }

  update(
    id: string,
    patch: Partial<Pick<CodemodeConnector, 'name' | 'trusted' | 'enabled'>>
  ): CodemodeConnector {
    const current = this.connectors.find((c) => c.id === id)
    if (!current) {
      throw new Error(`unknown connector: ${id}`)
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      this.assertName(patch.name)
    }
    const next: CodemodeConnector = {
      ...current,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.trusted !== undefined && { trusted: patch.trusted }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled })
    }
    this.commit(this.connectors.map((c) => (c.id === id ? next : c)))
    return { ...next }
  }

  remove(id: string): CodemodeConnector | null {
    const removed = this.connectors.find((c) => c.id === id)
    if (!removed) {
      return null
    }
    this.commit(this.connectors.filter((c) => c.id !== id))
    return { ...removed }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private assertName(name: string): void {
    if (!CODEMODE_CONNECTOR_NAME.test(name)) {
      throw new Error(`invalid connector name: ${name}`)
    }
    if (CODEMODE_RESERVED_NAMES.includes(name)) {
      throw new Error(`reserved connector name: ${name}`)
    }
    if (this.connectors.some((c) => c.name === name)) {
      throw new Error(`name taken: ${name}`)
    }
  }

  private commit(next: CodemodeConnector[]): void {
    writeSecureJsonFile(this.path, { version: 1, connectors: next })
    this.connectors = next
    for (const listener of this.listeners) {
      listener()
    }
  }
}
