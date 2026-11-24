import { randomUUID } from 'node:crypto'
import { getCompiledSchema } from '../../schema-validation/zod-schema-compilation'
import { formatZodError, type RpcRequest, type RpcResponse } from '../../runtime/rpc/core'
import { LOCAL_CLI_RPC_CALLER } from '../../runtime/rpc/callers/rpc-caller-identity'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatch/dispatcher-stream-options'
import { type OrcaMethodEntry, OrcaMethodIndex } from './codemode-orca-method-index'
import type { OrcaMethodSource } from './codemode-orca-method-policy'

export type OrcaRpcContext = {
  sessionId: string
  root: string
  worktreeId?: string
  workspaceId?: string
}

/** What a code-mode session may do with Orca's runtime: list, check and call exposed methods. */
export type OrcaRpcAccess = {
  index(): OrcaMethodIndex
  call(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
  context(): OrcaRpcContext
}

/** `RpcDispatcher.dispatch`, narrowed to what code mode sends. */
export type OrcaRpcDispatch = (
  request: Pick<
    RpcRequest,
    'id' | 'authToken' | 'method' | 'params' | 'orchestrationCompatibilityEvidence'
  >,
  options: Pick<RpcDispatchStreamingOptions, 'caller' | 'signal'>
) => Promise<RpcResponse>

export type OrcaRpcAccessDeps = {
  methods: readonly OrcaMethodSource[]
  dispatch: OrcaRpcDispatch
  sessionId: string
  root: string
  context?: () => { worktreeId?: string; workspaceId?: string }
}

// Why: in-process dispatch never checks the token; the caller identity below is what handlers trust.
const AUTH_TOKEN = 'codemode'

export function unavailableOrcaMethodText(name: string): string {
  return `${name} is not available in code mode`
}

/** The exposed method by name; excluded, streaming and unknown names are refused alike. */
export function exposedOrcaMethod(index: OrcaMethodIndex, name: string): OrcaMethodEntry {
  const entry = index.get(name)
  if (!entry) {
    throw new Error(unavailableOrcaMethodText(name))
  }
  return entry
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

/** Checks params as the dispatcher will; returns what to send (`undefined` for a no-params method). */
export function checkOrcaParams(entry: OrcaMethodEntry, params: unknown): unknown {
  if (entry.params === null) {
    if (params === undefined || params === null || isEmptyObject(params)) {
      return undefined
    }
    throw new Error(`${entry.name} takes no params`)
  }
  // Why: same parse and message as the dispatcher, so a refusal reads like the CLI's.
  const result = getCompiledSchema(entry.params).safeParse(params ?? {})
  if (!result.success) {
    throw new Error(formatZodError(result.error))
  }
  // The raw params go out: the dispatcher parses them again, and a transform must not run twice.
  return params
}

export function createOrcaRpcAccess(deps: OrcaRpcAccessDeps): OrcaRpcAccess {
  let index: OrcaMethodIndex | undefined
  const methodIndex = (): OrcaMethodIndex => {
    index ??= OrcaMethodIndex.from(deps.methods)
    return index
  }
  return {
    index: methodIndex,
    context: () => {
      const { worktreeId, workspaceId } = deps.context?.() ?? {}
      return {
        sessionId: deps.sessionId,
        root: deps.root,
        ...(worktreeId === undefined ? {} : { worktreeId }),
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    },
    call: async (method, params, signal) => {
      const entry = exposedOrcaMethod(methodIndex(), method)
      const sent = checkOrcaParams(entry, params)
      const response = await deps.dispatch(
        {
          id: randomUUID(),
          authToken: AUTH_TOKEN,
          method: entry.name,
          params: sent,
          orchestrationCompatibilityEvidence: { agentSessionId: deps.sessionId }
        },
        // Why: the agent caller, so owner-only handlers refuse scripts as they refuse the CLI.
        { caller: LOCAL_CLI_RPC_CALLER, signal }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    }
  }
}
