import type {
  CanUseTool,
  OnElicitation,
  OnUserDialog,
  PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudePromptRegistration,
  ClaudePromptRegistry,
  ClaudePromptReply
} from './claude-prompt-registry'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'
import type { ClaudeStreamJsonConnectionHandlers } from '../../claude-stream-json-connection'
import type { ClaudeStructuredLaunch } from '../launch/claude-structured-launch-resolution'
import { claudeLaunchSkipsPermissions } from '../launch/claude-structured-spawn-options'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'
import {
  claudePermissionPresentation,
  claudePermissionSubject
} from './claude-permission-presentation'
import {
  CLAUDE_ELICITATION_DECLINE,
  claudeElicitationPresentation
} from './claude-elicitation-prompt'

export type ClaudePermissionCallbackDeps = {
  sessionId: string
  prompts: ClaudePromptRegistry
  emit: (event: ClaudeStructuredSessionEvent) => void
  /** Read once per request: whether this process's Full access applied where the request arrived. */
  fullAccessAt: (requestId: string) => boolean
  /** This process was launched with code mode's `orca` server, whose approvals arrive as forms. */
  codemode?: boolean
}

/** The launch config name of code mode's server, as Claude reports it on an elicitation. */
const CODEMODE_SERVER_NAME = 'orca'

/** Questions and plan approval need the user's answer, not a permission; Full access never answers them. */
const USER_ANSWERED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** The SDK forwards the CLI's flag for tools whose card is the person's answer, though its type omits it. */
function needsUserAnswer(toolName: string, options: Parameters<CanUseTool>[2]): boolean {
  return (
    USER_ANSWERED_TOOLS.has(toolName) ||
    ('requiresUserInteraction' in options && options.requiresUserInteraction === true)
  )
}

function isPermissionResult(reply: ClaudePromptReply): reply is PermissionResult {
  return 'behavior' in reply
}

function denySafeResult(toolUseId: string | undefined): PermissionResult {
  return {
    behavior: 'deny',
    message: 'Orca could not decode this permission request.',
    ...(toolUseId ? { toolUseID: toolUseId } : {})
  }
}

/** Opens a card and waits for the person; provider cancellation withdraws it. */
function awaitClaudePromptAnswer<R>(
  deps: ClaudePermissionCallbackDeps,
  registration: Omit<ClaudePromptRegistration, 'settle'>,
  signal: AbortSignal,
  answer: (reply: ClaudePromptReply | null) => R,
  unregistered: R
): Promise<R> {
  return new Promise<R>((resolve) => {
    let cancel = (): void => {}
    const settle = (reply: ClaudePromptReply | null): void => {
      signal.removeEventListener('abort', cancel)
      resolve(answer(reply))
    }
    const prompt = deps.prompts.register({ ...registration, settle })
    if (!prompt) {
      resolve(unregistered)
      return
    }
    cancel = (): void => {
      if (deps.prompts.forgetIfPending(prompt)) {
        deps.emit({
          type: 'prompt-cancelled',
          sessionId: deps.sessionId,
          promptKey: prompt.promptKey
        })
        settle(null)
      }
    }
    if (signal.aborted) {
      // Abort events are not replayed for listeners added after cancellation.
      cancel()
      return
    }
    signal.addEventListener('abort', cancel, { once: true })
    deps.emit({ type: 'prompt', sessionId: deps.sessionId, prompt })
  })
}

/** Malformed requests are denied; provider cancellation forgets the callback without replying. */
export function buildClaudePermissionCallbacks(deps: ClaudePermissionCallbackDeps): {
  canUseTool: CanUseTool
  onUserDialog: OnUserDialog
  onElicitation: OnElicitation
} {
  const canUseTool: CanUseTool = (toolName, input, options) => {
    const fullAccess = deps.fullAccessAt(options.requestId)
    // Full access approves Claude's own asks too (ask rules, ask-answering hooks, built-in safety checks).
    if (fullAccess && toolName && !needsUserAnswer(toolName, options)) {
      return Promise.resolve({
        behavior: 'allow',
        updatedInput: input,
        ...(options.toolUseID ? { toolUseID: options.toolUseID } : {})
      })
    }
    const subject = claudePermissionSubject(toolName, input)
    return awaitClaudePromptAnswer<PermissionResult | null>(
      deps,
      {
        ...claudePermissionPresentation(options),
        ...(subject ? { subject } : {}),
        requestId: options.requestId,
        toolName,
        toolUseId: options.toolUseID,
        input,
        suggestions: options.suggestions ?? [],
        ...(options.agentID ? { agentId: options.agentID } : {})
      },
      options.signal,
      // Null tells the SDK to write no response to the cancelled request.
      (reply) => (reply && isPermissionResult(reply) ? reply : null),
      denySafeResult(options.toolUseID)
    )
  }

  const onUserDialog: OnUserDialog = () => Promise.resolve({ behavior: 'cancelled' })

  // An MCP server's question is the person's to answer: Full access never answers it. Only code
  // mode's own approvals are shown; any other server's question is declined as before, unasked.
  const onElicitation: OnElicitation = (request, options) => {
    if (deps.codemode !== true || request.serverName !== CODEMODE_SERVER_NAME) {
      return Promise.resolve(CLAUDE_ELICITATION_DECLINE)
    }
    const form = claudeElicitationPresentation(request)
    if (!form) {
      return Promise.resolve(CLAUDE_ELICITATION_DECLINE)
    }
    return awaitClaudePromptAnswer(
      deps,
      {
        ...(request.title ? { title: request.title } : {}),
        ...(request.displayName ? { displayName: request.displayName } : {}),
        ...(request.description ? { description: request.description } : {}),
        requestId: options.requestId,
        toolName: request.serverName,
        // No tool call carries an elicitation; the request id keys it alone.
        toolUseId: `elicitation:${options.requestId}`,
        input: {},
        suggestions: [],
        form
      },
      options.signal,
      (reply) => (reply && !isPermissionResult(reply) ? reply : CLAUDE_ELICITATION_DECLINE),
      CLAUDE_ELICITATION_DECLINE
    )
  }

  return { canUseTool, onUserDialog, onElicitation }
}

type ClaudeExitHandler = NonNullable<ClaudeStreamJsonConnectionHandlers['onExit']>

/** One process's permission handlers. Only Orca's Full access launch grants auto-allow; Own settings
 *  never does, whatever Claude reports, and no other process's launch or reports carry over. */
export function claudeLaunchPermissions(
  deps: Omit<ClaudePermissionCallbackDeps, 'fullAccessAt' | 'codemode'>,
  launch: Pick<ClaudeStructuredLaunch, 'options' | 'providerSessionId' | 'codemode'>
): {
  handlers: Pick<
    ClaudeStreamJsonConnectionHandlers,
    'canUseTool' | 'onUserDialog' | 'onElicitation' | 'onStdout'
  >
  /** Claude's mode in wire order; null without Full access, whose launches read no stdout. */
  orderedMode: (() => string | null | undefined) | null
  /** Wraps the connection's exit handler: this process's permission state ends first. */
  closeThen: (onExit: ClaudeExitHandler) => ClaudeExitHandler
} {
  const policy = claudeLaunchSkipsPermissions(launch.options)
    ? createClaudeFullAccessPolicy(launch.providerSessionId)
    : null
  const callbacks = buildClaudePermissionCallbacks({
    ...deps,
    fullAccessAt: (requestId) => policy?.allows(requestId) ?? false,
    codemode: launch.codemode === true
  })
  return {
    handlers: { ...callbacks, ...(policy ? { onStdout: policy.observe } : {}) },
    orderedMode: policy ? policy.mode : null,
    closeThen: (onExit) => (error, exit) => {
      policy?.close()
      onExit(error, exit)
    }
  }
}
