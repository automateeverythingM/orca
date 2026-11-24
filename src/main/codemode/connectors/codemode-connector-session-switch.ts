import type { CodemodeConnector } from '../../../shared/codemode/codemode-connector-types'
import type { CodemodeConnectorAccess } from '../mcp-pool/codemode-mcp-pool'
import type { CodemodeConnectorPool } from './codemode-connector-pool'
import type { CodemodeConnectorStore } from './codemode-connector-store'

export type { CodemodeConnectorAccess } from '../mcp-pool/codemode-mcp-pool'

/** Session-record option holding the ids of the connectors this chat switched off, comma-separated. */
export const CONNECTORS_OFF_OPTION = 'codemode.connectorsOff'

const CONNECTOR_ID = /^[A-Za-z0-9_-]{1,64}$/
// Why: record options are validated on load; a longer value or a 33rd key would make the record unreadable.
const OPTION_VALUE_LIMIT = 512
const OPTION_COUNT_LIMIT = 32

type Options = Readonly<Record<string, string>>

/** Where a chat's options live: the session record in the app, memory elsewhere. */
export type CodemodeSessionOptionsAccess = {
  read(sessionId: string): Options | undefined
  write(sessionId: string, options: Options): Promise<void>
}

export function memorySessionOptions(): CodemodeSessionOptionsAccess {
  const saved = new Map<string, Options>()
  return {
    read: (sessionId) => saved.get(sessionId),
    write: async (sessionId, options) => {
      saved.set(sessionId, options)
    }
  }
}

function validIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((id) => id.trim()).filter((id) => CONNECTOR_ID.test(id)))]
}

export function readConnectorsOff(
  record: { options?: Options | undefined } | null | undefined
): Set<string> {
  const value = record?.options?.[CONNECTORS_OFF_OPTION]
  return new Set(typeof value === 'string' ? validIds(value.split(',')) : [])
}

export function writeConnectorsOff(
  options: Options | undefined,
  ids: Iterable<string>
): Record<string, string> {
  const { [CONNECTORS_OFF_OPTION]: _previous, ...rest } = options ?? {}
  const value = validIds(ids).sort().join(',')
  if (value === '') {
    return rest
  }
  if (value.length > OPTION_VALUE_LIMIT) {
    throw new Error('too many connectors switched off in this chat')
  }
  if (Object.keys(rest).length >= OPTION_COUNT_LIMIT) {
    throw new Error('this chat has too many options to switch connectors off')
  }
  return { ...rest, [CONNECTORS_OFF_OPTION]: value }
}

/** Connectors a chat reaches by name: only enabled ones it has not switched off, resolved per call. */
export function connectorAccess(deps: {
  store: Pick<CodemodeConnectorStore, 'list' | 'byName'>
  pool: Pick<CodemodeConnectorPool, 'describe' | 'call'>
  off: () => ReadonlySet<string>
}): CodemodeConnectorAccess {
  const usable = (connector: CodemodeConnector | null): connector is CodemodeConnector =>
    connector !== null && connector.enabled && !deps.off().has(connector.id)
  const resolve = (name: string): CodemodeConnector => {
    const connector = deps.store.byName(name)
    if (!usable(connector)) {
      throw new Error(`unknown MCP server ${name}`)
    }
    return connector
  }
  return {
    names: () =>
      deps.store
        .list()
        .filter(usable)
        .map((connector) => connector.name),
    describe: (name, signal) => deps.pool.describe(resolve(name).id, signal),
    call: (name, tool, args, signal) => deps.pool.call(resolve(name).id, tool, args, signal)
  }
}

/** A connector's own `trusted` flag; a local server is trusted when its name is in the setting. */
export function codemodeServerTrust(deps: {
  connectors: Pick<CodemodeConnectorAccess, 'names'> | undefined
  connectorTrusted: (name: string) => boolean
  trustedServers: () => readonly string[]
}): (server: string) => boolean {
  return (server) =>
    deps.connectors?.names().includes(server) === true
      ? deps.connectorTrusted(server)
      : deps.trustedServers().includes(server)
}
