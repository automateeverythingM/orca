// Agents reach connectors as direct MCP servers through Orca's tool relay at `/c/<connectorId>/mcp`,
// with their chat's code-mode token; the relay attaches the connector's secret.
import type { RelayAllowance, RelayRoute } from '../../bots/tool-relay/bot-tool-relay-routes'
import {
  connectorCredentialSource,
  type OpenedConnectors
} from './codemode-connector-credential-source'
import { CODEMODE_CONNECTOR_CREDENTIAL_FOLDER } from './codemode-connector-store'

export const CONNECTOR_RELAY_PATH = /^\/c\/([A-Za-z0-9_-]{8,64})\/mcp(?:\?.*)?$/

const CALLER_PREFIX = 'codemode:'

export const codemodeCallerKey = (sessionId: string): string => `${CALLER_PREFIX}${sessionId}`

/** What the route reads from the code-mode service, live on every request. */
export type ConnectorRelayHost = {
  /** The live session a code-mode token belongs to; null once its session ended. */
  resolveToken(token: string): string | null
  openedConnectors(): OpenedConnectors | null
  connectorsOff(sessionId: string): ReadonlySet<string>
}

const UNKNOWN_CONNECTOR = 'unknown connector'
const UNKNOWN: RelayAllowance = { ok: false, status: 404, message: UNKNOWN_CONNECTOR }

export function createConnectorRelayRoute(service: ConnectorRelayHost): RelayRoute {
  return {
    pattern: CONNECTOR_RELAY_PATH,
    resolve: (token) => {
      const sessionId = service.resolveToken(token)
      return sessionId === null
        ? null
        : { callerKey: codemodeCallerKey(sessionId), folder: CODEMODE_CONNECTOR_CREDENTIAL_FOLDER }
    },
    allow: (callerKey, connectorId) => {
      const connector = service.openedConnectors()?.store.get(connectorId)
      if (!connector?.enabled || !callerKey.startsWith(CALLER_PREFIX)) {
        return UNKNOWN
      }
      if (service.connectorsOff(callerKey.slice(CALLER_PREFIX.length)).has(connectorId)) {
        return {
          ok: false,
          status: 403,
          message: `connector ${connector.name} is off for this chat`
        }
      }
      return { ok: true }
    },
    source: connectorCredentialSource(() => service.openedConnectors()),
    signInNeeded: (connectorId) => {
      const name = service.openedConnectors()?.store.get(connectorId)?.name ?? connectorId
      return `connector ${name} needs sign-in`
    },
    missing: UNKNOWN_CONNECTOR,
    unauthorized: 'This connector needs the chat’s Orca token.'
  }
}
