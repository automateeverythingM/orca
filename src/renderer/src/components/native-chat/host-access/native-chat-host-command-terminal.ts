import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { createWebRuntimeSessionTerminalOnHost } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { notifyWebRuntimeTerminalCreateFailure } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-failure-notice'
import { startStoppedWslHostForUserAct } from '@/runtime/hosts/wsl/wsl-host-user-start'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatHostCommandTerminal = {
  opening: boolean
  open: (command: string, env?: Record<string, string>) => Promise<boolean>
}

/** Opens a visible terminal on the chat's own host running a command; null without a workspace. */
export function useNativeChatHostCommandTerminal(input: {
  target: RuntimeClientTarget
  worktreeId: string | null
  groupId?: string
  /** Chat tab to look up its tab group when `groupId` is not supplied explicitly. */
  sourceTabId?: string
  /** Working directory for subfolder chats; omitted uses the workspace root. */
  cwd?: string
}): NativeChatHostCommandTerminal | null {
  const { worktreeId, groupId, sourceTabId, cwd } = input
  const environmentId = input.target.kind === 'environment' ? input.target.environmentId : null
  const [opening, setOpening] = useState(false)
  // Why a ref: a notice and a transcript row can both press, and state lags a double press.
  const openingRef = useRef(false)
  const open = useCallback(
    (command: string, env?: Record<string, string>) => {
      if (!worktreeId || openingRef.current) {
        return Promise.resolve(false)
      }
      openingRef.current = true
      setOpening(true)
      return (async () => {
        const store = useAppStore.getState()
        const resolvedGroupId =
          groupId ??
          (sourceTabId
            ? store.unifiedTabsByWorktree[worktreeId]?.find(
                (entry) => entry.entityId === sourceTabId
              )?.groupId
            : undefined)
        if (environmentId) {
          if (!(await startStoppedWslHostForUserAct(environmentId))) {
            return false
          }
          const outcome = await createWebRuntimeSessionTerminalOnHost(
            {
              worktreeId,
              environmentId,
              targetGroupId: resolvedGroupId,
              command,
              ...(cwd && { cwd }),
              ...(env && { env }),
              viewMode: 'terminal',
              activate: true
            },
            { notifyFailure: false }
          )
          if (outcome.status === 'failed') {
            notifyWebRuntimeTerminalCreateFailure(outcome.message, { environmentId, worktreeId })
            return false
          }
        } else {
          const tab = store.createTab(worktreeId, resolvedGroupId, undefined, {
            ...(cwd && { startupCwd: cwd }),
            pendingStartup: { command, ...(env && { env }) },
            viewMode: 'terminal'
          })
          store.setActiveTabType('terminal', worktreeId)
          persistAgentLaunchTabOrder(worktreeId, tab.id)
        }
        return true
      })()
        .catch(() => {
          toast.error(
            translate(
              'auto.store.slices.worktrees.localBaseRefUnshallowFailed',
              'Could not open a terminal for this workspace'
            )
          )
          return false
        })
        .finally(() => {
          openingRef.current = false
          setOpening(false)
        })
    },
    [worktreeId, groupId, sourceTabId, cwd, environmentId]
  )
  return useMemo(() => (worktreeId ? { opening, open } : null), [worktreeId, opening, open])
}
