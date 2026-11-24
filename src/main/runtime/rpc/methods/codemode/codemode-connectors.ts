import type {
  CodemodeConnector,
  CodemodeConnectorView,
  CodemodeSessionConnectorView
} from '../../../../../shared/codemode/codemode-connector-types'
import {
  CodemodeConnectorAdd,
  CodemodeConnectorRegistrySearch,
  CodemodeConnectorSetToken,
  CodemodeConnectorSignInCancel,
  CodemodeConnectorTarget,
  CodemodeConnectorUpdate,
  CodemodeSessionConnectors,
  CodemodeSessionConnectorToggle
} from '../../../../../shared/rpc-contract/codemode/codemode-connectors-params'
import { installedCodemodeService } from '../../../../codemode/codemode-process-service'
import type {
  CodemodeConnectorWiring,
  CodemodeService
} from '../../../../codemode/codemode-service'
import {
  searchRegistry,
  type RegistryPage
} from '../../../../codemode/connectors/codemode-registry-search'
import { defineMethod, type RpcContext } from '../../core'
import { requireInstalledStructuredHost } from '../structured-sessions/creation/structured-agent-session-gate'

export type CodemodeConnectorMethodDeps = {
  /** Code mode runs only in the desktop app (its worker and WASM ship only there). */
  desktop: () => boolean
  /** The process's one code-mode service, the one chats launch with. */
  service: (ctx: RpcContext) => Promise<CodemodeService>
  /** Refuses a caller that may not manage this chat, as `agentSession.mcp` does. */
  sessionAccess: (ctx: RpcContext, sessionId: string) => Promise<void>
  search: (query: string, opts: { cursor?: string; signal?: AbortSignal }) => Promise<RegistryPage>
}

async function runtimeCodemodeService(ctx: RpcContext): Promise<CodemodeService> {
  // Why: the host's install creates the service with the chats' options; never build a second one.
  await ctx.runtime.ensureStructuredAgentSessionHost()
  const service = installedCodemodeService()
  if (!service) {
    throw new Error('connectors unavailable')
  }
  return service
}

async function runtimeSessionAccess(ctx: RpcContext, sessionId: string): Promise<void> {
  const host = await requireInstalledStructuredHost(ctx, sessionId)
  if (!host.deps.store.getRecord(sessionId)) {
    throw new Error(`unknown session: ${sessionId}`)
  }
}

const RUNTIME_DEPS: CodemodeConnectorMethodDeps = {
  desktop: () => process.versions.electron !== undefined,
  service: runtimeCodemodeService,
  sessionAccess: runtimeSessionAccess,
  search: searchRegistry
}

type Opened = { service: CodemodeService; wiring: CodemodeConnectorWiring }

function viewOf(
  wiring: CodemodeConnectorWiring,
  connector: CodemodeConnector
): CodemodeConnectorView {
  return { ...connector, status: wiring.auth.status(connector.id) }
}

function requireConnector(wiring: CodemodeConnectorWiring, id: string): CodemodeConnector {
  const connector = wiring.store.get(id)
  if (!connector) {
    throw new Error(`unknown connector: ${id}`)
  }
  return connector
}

/** `codemode.connectors.*`: the user's MCP connectors and each chat's switches. Results carry no secret. */
export function codemodeConnectorMethods(deps: CodemodeConnectorMethodDeps) {
  const requireDesktop = (): void => {
    if (!deps.desktop()) {
      throw new Error('code mode is only available in the desktop app')
    }
  }
  const open = async (ctx: RpcContext): Promise<Opened> => {
    requireDesktop()
    const service = await deps.service(ctx)
    const wiring = await service.openConnectors()
    if (!wiring) {
      throw new Error('connectors unavailable')
    }
    return { service, wiring }
  }
  const sessionView = ({ service }: Opened, sessionId: string): CodemodeSessionConnectorView[] =>
    service.connectorsForSession(sessionId).map(({ connector, on, status }) => ({
      id: connector.id,
      name: connector.name,
      on: on && connector.enabled,
      enabled: connector.enabled,
      status
    }))

  return [
    defineMethod({
      name: 'codemode.connectors.list',
      permission: 'workspace',
      params: null,
      handler: async (_params, ctx): Promise<{ connectors: CodemodeConnectorView[] }> => {
        const { wiring } = await open(ctx)
        return { connectors: wiring.store.list().map((c) => viewOf(wiring, c)) }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.add',
      permission: 'workspace',
      params: CodemodeConnectorAdd,
      handler: async (params, ctx): Promise<{ connector: CodemodeConnectorView }> => {
        const { wiring } = await open(ctx)
        const added = await wiring.auth.add({
          url: params.url,
          ...(params.name !== undefined ? { name: params.name } : {})
        })
        return { connector: viewOf(wiring, added) }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.update',
      permission: 'workspace',
      params: CodemodeConnectorUpdate,
      handler: async (params, ctx): Promise<{ connector: CodemodeConnectorView }> => {
        const { wiring } = await open(ctx)
        const updated = wiring.store.update(params.id, {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.trusted !== undefined ? { trusted: params.trusted } : {}),
          ...(params.enabled !== undefined ? { enabled: params.enabled } : {})
        })
        return { connector: viewOf(wiring, updated) }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.remove',
      permission: 'workspace',
      params: CodemodeConnectorTarget,
      handler: async (params, ctx): Promise<{ removed: string }> => {
        const { wiring } = await open(ctx)
        await wiring.auth.remove(params.id)
        return { removed: params.id }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.setToken',
      permission: 'workspace',
      params: CodemodeConnectorSetToken,
      handler: async (params, ctx): Promise<{ connector: CodemodeConnectorView }> => {
        const { wiring } = await open(ctx)
        wiring.auth.setToken(params.id, params.token)
        return { connector: viewOf(wiring, requireConnector(wiring, params.id)) }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.signIn.start',
      permission: 'workspace',
      params: CodemodeConnectorTarget,
      handler: async (params, ctx) => {
        const { wiring } = await open(ctx)
        const { attemptId, authorizationOrigin } = await wiring.auth.startSignIn(params.id)
        return { attemptId, authorizationOrigin }
      }
    }),
    defineMethod({
      // Read from memory, so the settings page can ask often while the browser is open.
      name: 'codemode.connectors.signIn.status',
      permission: 'workspace',
      params: CodemodeConnectorTarget,
      handler: async (params, ctx) => {
        const { wiring } = await open(ctx)
        requireConnector(wiring, params.id)
        return wiring.auth.signInProgress(params.id)
      }
    }),
    defineMethod({
      name: 'codemode.connectors.signIn.cancel',
      permission: 'workspace',
      params: CodemodeConnectorSignInCancel,
      handler: async (params, ctx): Promise<{ cancelled: true }> => {
        const { wiring } = await open(ctx)
        requireConnector(wiring, params.id)
        wiring.auth.cancelSignIn(params.id, params.attemptId)
        return { cancelled: true }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.registry.search',
      permission: 'workspace',
      params: CodemodeConnectorRegistrySearch,
      handler: async (params, ctx): Promise<RegistryPage> => {
        requireDesktop()
        return await deps.search(params.query, {
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {})
        })
      }
    }),
    defineMethod({
      name: 'codemode.connectors.session.list',
      permission: 'workspace',
      params: CodemodeSessionConnectors,
      handler: async (params, ctx): Promise<{ connectors: CodemodeSessionConnectorView[] }> => {
        const opened = await open(ctx)
        await deps.sessionAccess(ctx, params.sessionId)
        return { connectors: sessionView(opened, params.sessionId) }
      }
    }),
    defineMethod({
      name: 'codemode.connectors.session.toggle',
      permission: 'workspace',
      params: CodemodeSessionConnectorToggle,
      handler: async (params, ctx): Promise<{ connector: CodemodeSessionConnectorView }> => {
        const opened = await open(ctx)
        await deps.sessionAccess(ctx, params.sessionId)
        requireConnector(opened.wiring, params.id)
        await opened.service.setConnectorOff(params.sessionId, params.id, !params.on)
        const connector = sessionView(opened, params.sessionId).find((c) => c.id === params.id)
        if (!connector) {
          throw new Error(`unknown connector: ${params.id}`)
        }
        return { connector }
      }
    })
  ]
}

export const CODEMODE_CONNECTOR_METHODS = codemodeConnectorMethods(RUNTIME_DEPS)
