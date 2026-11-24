// Code mode's MCP connectors, read and changed on this computer's runtime (code mode is desktop-only).
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  CodemodeConnectorView,
  CodemodeSessionConnectorView
} from '../../../../../shared/codemode/codemode-connector-types'
import {
  botToolSignInFailureWords,
  type BotToolSignInProgress
} from '../../../../../shared/bot-tool-sign-in'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

/** A server found in the MCP Registry; `auth` is what Add will ask for. */
export type CodemodeRegistryEntry = {
  name: string
  title: string
  description: string
  url: string
  auth: 'oauth' | 'token'
  iconUrl?: string
}

export type CodemodeRegistryPage = { entries: CodemodeRegistryEntry[]; nextCursor?: string }

/** A connector URL as a row shows it: the host, or the text itself when it doesn't parse. */
export function codemodeUrlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The runtime's own words for a refused change (a taken name, an unreachable URL), else a generic line. */
export function codemodeConnectorErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError && error.message) {
    return error.message
  }
  return translate('settings.codemode.connectors.genericError', 'Something went wrong. Try again.')
}

export async function listCodemodeConnectors(): Promise<CodemodeConnectorView[]> {
  const { connectors } = await callRuntimeRpc<{ connectors: CodemodeConnectorView[] }>(
    LOCAL,
    'codemode.connectors.list'
  )
  return connectors
}

export async function listCodemodeSessionConnectors(
  sessionId: string
): Promise<CodemodeSessionConnectorView[]> {
  const { connectors } = await callRuntimeRpc<{ connectors: CodemodeSessionConnectorView[] }>(
    LOCAL,
    'codemode.connectors.session.list',
    { sessionId }
  )
  return connectors
}

export async function toggleCodemodeSessionConnector(
  sessionId: string,
  id: string,
  on: boolean
): Promise<void> {
  await callRuntimeRpc(LOCAL, 'codemode.connectors.session.toggle', { sessionId, id, on })
}

export async function addCodemodeConnector(
  url: string,
  name?: string
): Promise<CodemodeConnectorView> {
  const { connector } = await callRuntimeRpc<{ connector: CodemodeConnectorView }>(
    LOCAL,
    'codemode.connectors.add',
    { url, ...(name ? { name } : {}) }
  )
  return connector
}

export async function updateCodemodeConnector(
  id: string,
  changes: { trusted?: boolean; enabled?: boolean }
): Promise<CodemodeConnectorView> {
  const { connector } = await callRuntimeRpc<{ connector: CodemodeConnectorView }>(
    LOCAL,
    'codemode.connectors.update',
    { id, ...changes }
  )
  return connector
}

export async function removeCodemodeConnector(id: string): Promise<void> {
  await callRuntimeRpc(LOCAL, 'codemode.connectors.remove', { id })
}

export async function setCodemodeConnectorToken(
  id: string,
  token: string
): Promise<CodemodeConnectorView> {
  const { connector } = await callRuntimeRpc<{ connector: CodemodeConnectorView }>(
    LOCAL,
    'codemode.connectors.setToken',
    { id, token }
  )
  return connector
}

export function searchCodemodeRegistry(
  query: string,
  cursor?: string
): Promise<CodemodeRegistryPage> {
  return callRuntimeRpc<CodemodeRegistryPage>(LOCAL, 'codemode.connectors.registry.search', {
    query,
    ...(cursor ? { cursor } : {})
  })
}

/** Opens the connector's sign-in in the browser (the runtime opens it); answers the attempt to cancel. */
export async function startCodemodeConnectorSignIn(id: string): Promise<string> {
  const { attemptId } = await callRuntimeRpc<{ attemptId: string }>(
    LOCAL,
    'codemode.connectors.signIn.start',
    { id }
  )
  return attemptId
}

export async function cancelCodemodeConnectorSignIn(id: string, attemptId?: string): Promise<void> {
  await callRuntimeRpc(LOCAL, 'codemode.connectors.signIn.cancel', {
    id,
    ...(attemptId ? { attemptId } : {})
  })
}

/** Null when the read failed: a missed read is not an end, so the watch keeps waiting. */
function readSignInProgress(id: string): Promise<BotToolSignInProgress | null> {
  return callRuntimeRpc<BotToolSignInProgress>(
    LOCAL,
    'codemode.connectors.signIn.status',
    { id },
    { background: true }
  ).catch(() => null)
}

const expired = (): string => botToolSignInFailureWords('expired', '', translate)

const SIGN_IN_POLL_MS = 2_000
const SIGN_IN_WATCH_MS = 600_000

/** Why a sign-in ended without a sign-in, in words; null when it finished. */
export type CodemodeSignInEnd = { failure: string | null }

/**
 * Asks the runtime how the connector's sign-in is going every 2 s, for up to 10 minutes, and calls
 * `onEnd` once when it ends. The returned stop ends the watch without calling `onEnd`.
 */
export function watchCodemodeConnectorSignIn(
  id: string,
  onEnd: (end: CodemodeSignInEnd) => void
): () => void {
  const deadline = Date.now() + SIGN_IN_WATCH_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let live = true
  const tick = async (): Promise<void> => {
    const progress = await readSignInProgress(id)
    if (!live) {
      return
    }
    const waiting = progress === null || progress.state === 'waiting'
    if (waiting && Date.now() < deadline) {
      timer = setTimeout(() => void tick(), SIGN_IN_POLL_MS)
      return
    }
    live = false
    onEnd({ failure: progress === null ? expired() : signInFailure(progress) })
  }
  timer = setTimeout(() => void tick(), SIGN_IN_POLL_MS)
  return () => {
    live = false
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function signInFailure(progress: BotToolSignInProgress): string | null {
  switch (progress.state) {
    case 'done':
    case 'idle':
      return null
    case 'waiting':
      return expired()
    case 'failed':
      return progress.code === 'no-tool'
        ? translate('settings.codemode.connectors.signInRemoved', 'This connector was removed.')
        : botToolSignInFailureWords(progress.code, '', translate)
  }
}
