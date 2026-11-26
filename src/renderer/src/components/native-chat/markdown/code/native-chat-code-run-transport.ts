import type { NativeChatCodeBlockRunFrame } from '../../../../../../shared/native-chat/code-block-run/native-chat-code-block-run-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import { startStoppedWslHostForUserAct } from '@/runtime/hosts/wsl/wsl-host-user-start'

export type NativeChatCodeBlockRunTransport = (
  args: { command: string; language?: string },
  handlers: {
    onFrame: (frame: NativeChatCodeBlockRunFrame) => void
    onError: (message: string) => void
    onClose: () => void
  }
) => Promise<{ unsubscribe: () => void }>

export function extractCodeBlockRunErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }
  return 'Command failed to start'
}

function isRunFrame(value: unknown): value is NativeChatCodeBlockRunFrame {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  const { type } = value
  if (type === 'started') {
    return 'cwd' in value && typeof value.cwd === 'string'
  }
  if (type === 'output') {
    return (
      'stream' in value &&
      (value.stream === 'stdout' || value.stream === 'stderr') &&
      'text' in value &&
      typeof value.text === 'string'
    )
  }
  if (type === 'exit') {
    return (
      'status' in value &&
      (value.status === 'succeeded' || value.status === 'failed' || value.status === 'cancelled') &&
      'durationMs' in value &&
      typeof value.durationMs === 'number'
    )
  }
  return false
}

export function createRuntimeCodeBlockRunTransport(input: {
  target: RuntimeClientTarget
  worktreeId: string
  cwd?: string
}): NativeChatCodeBlockRunTransport {
  const { target, worktreeId, cwd } = input
  const environmentId = target.kind === 'environment' ? target.environmentId : null

  return async ({ command, language }, handlers) => {
    if (environmentId) {
      const started = await startStoppedWslHostForUserAct(environmentId)
      if (!started) {
        throw new Error('Could not start workspace host')
      }
    }
    return subscribeRuntimeRpc(
      target,
      'nativeChat.runCodeBlock',
      {
        worktreeId,
        command,
        ...(cwd ? { cwd } : {}),
        ...(language ? { language } : {})
      },
      {
        onEvent: (frame) => {
          if (isRunFrame(frame)) {
            handlers.onFrame(frame)
          }
        },
        onError: (error) => {
          handlers.onError(extractCodeBlockRunErrorMessage(error))
        },
        onClose: handlers.onClose
      }
    )
  }
}
