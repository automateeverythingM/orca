import { useCallback, useMemo } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { recomputeOn } from '@/lib/recompute-on'
import { recordChangeReaches } from '@/store/record-transitions/keyed-record-change-reads'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { AgentStatusProjection } from '@/store/slices/agent-status/projection/agent-status-projection'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { useAgentPresentation } from './useWorktreeAgentRows'

export function isSessionMarkedComplete(
  completedAt: number | undefined,
  entry?: Pick<AgentStatusEntry, 'stateStartedAt' | 'sessionBoundary'>
): boolean {
  if (typeof completedAt !== 'number' || completedAt <= 0) {
    return false
  }
  // A newer non-boundary turn started after completion automatically reopens the session.
  if (entry && entry.sessionBoundary !== true && entry.stateStartedAt > completedAt) {
    return false
  }
  return true
}

export function isHiddenCompletedRootSession(
  projection: AgentStatusProjection,
  completedByPaneKey: Readonly<Record<string, number>>,
  paneKey: string
): boolean {
  const row = projection.row(paneKey)
  if (!row || !isSessionMarkedComplete(completedByPaneKey[paneKey], row.entry)) {
    return false
  }
  // Keep a completed parent visible while any descendant is working or needs attention.
  return projection.display.children(paneKey).signal === undefined
}

function createRootsCompletedSelector(worktreeId: string) {
  let roots: readonly string[] | undefined
  let projection: AgentStatusProjection | undefined
  let revision = 0
  let completedMap: AppState['completedSessionsByPaneKey'] | undefined
  let rootKeys: ReadonlySet<string> = new Set()
  let result: readonly string[] = []
  const readsKey = (key: string): boolean => rootKeys.has(key)
  return (
    state: Pick<AppState, 'agentStatusByPaneKey' | 'completedSessionsByPaneKey'>,
    nextRoots: readonly string[]
  ): readonly string[] => {
    const nextProjection = state.agentStatusByPaneKey.projection
    const nextRevision = nextProjection.revision(worktreeId)
    const unchanged =
      nextRoots === roots &&
      nextProjection === projection &&
      nextRevision === revision &&
      !recordChangeReaches(state.completedSessionsByPaneKey, completedMap, readsKey)
    completedMap = state.completedSessionsByPaneKey
    if (unchanged) {
      return result
    }
    roots = nextRoots
    projection = nextProjection
    revision = nextRevision
    rootKeys = new Set(nextRoots)
    const visible = nextRoots.filter(
      (key) => !isHiddenCompletedRootSession(nextProjection, state.completedSessionsByPaneKey, key)
    )
    const next = visible.length === nextRoots.length ? nextRoots : visible
    if (next.length !== result.length || next.some((key, index) => key !== result[index])) {
      result = next
    }
    return result
  }
}

export function useVisibleWorktreeAgentRoots(
  worktreeId: string,
  hostRoots: readonly string[]
): readonly string[] {
  const hideCompletedSessions = useAppStateValue((s) => s.hideCompletedSessions)
  const isSendTarget = useAppStateValue(
    useCallback((s) => s.agentSendPopoverTargetMode?.worktreeId === worktreeId, [worktreeId])
  )
  const filterCompleted = hideCompletedSessions && !isSendTarget
  // Subscribe to workspace row updates only while filtering so a new turn reopens a completed row.
  const revision = useAgentPresentation(
    `list\0${worktreeId}`,
    useCallback((p) => p.revision(worktreeId), [worktreeId]),
    filterCompleted
  )
  const selectVisible = useMemo(() => createRootsCompletedSelector(worktreeId), [worktreeId])
  const filteredRoots = useAppStateValue(
    useCallback(
      (s) =>
        recomputeOn([revision], () => (filterCompleted ? selectVisible(s, hostRoots) : hostRoots)),
      [filterCompleted, hostRoots, revision, selectVisible]
    )
  )
  return filterCompleted ? filteredRoots : hostRoots
}

function createVisibleRowsSelector() {
  let rows: readonly DashboardAgentRow[] | undefined
  let completedMap: AppState['completedSessionsByPaneKey'] | undefined
  let rowKeys: ReadonlySet<string> = new Set()
  let result: readonly DashboardAgentRow[] = []
  const readsKey = (key: string): boolean => rowKeys.has(key)
  return (
    state: Pick<AppState, 'completedSessionsByPaneKey'>,
    nextRows: readonly DashboardAgentRow[]
  ): readonly DashboardAgentRow[] => {
    const unchanged =
      nextRows === rows &&
      !recordChangeReaches(state.completedSessionsByPaneKey, completedMap, readsKey)
    completedMap = state.completedSessionsByPaneKey
    if (unchanged) {
      return result
    }
    rows = nextRows
    rowKeys = new Set(nextRows.map((row) => row.paneKey))
    const visible = nextRows.filter(
      (row) => !isSessionMarkedComplete(state.completedSessionsByPaneKey[row.paneKey], row.entry)
    )
    result = visible.length === nextRows.length ? nextRows : visible
    return result
  }
}

export function useVisibleNonCompletedRows(
  rows: readonly DashboardAgentRow[]
): readonly DashboardAgentRow[] {
  const hideCompletedSessions = useAppStateValue((s) => s.hideCompletedSessions)
  const selectVisible = useMemo(() => createVisibleRowsSelector(), [])
  return useAppStateValue(
    useCallback(
      (s) => (hideCompletedSessions ? selectVisible(s, rows) : rows),
      [hideCompletedSessions, rows, selectVisible]
    )
  )
}
