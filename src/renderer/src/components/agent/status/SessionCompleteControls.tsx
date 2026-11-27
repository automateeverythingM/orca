import React, { useCallback } from 'react'
import { CheckCheck, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import {
  StateIndicatorTooltip,
  type StateIndicatorTooltipSide
} from '@/components/agent/status/StateIndicatorTooltip'
import { isSessionMarkedComplete } from '@/components/sidebar/workspace-card/activity/worktree-completed-session-visibility'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

export function useSessionCompletedState(
  paneKey: string,
  entry?: Pick<AgentStatusEntry, 'stateStartedAt' | 'sessionBoundary'>
): { isCompleted: boolean; toggleCompleted: () => void } {
  const completedAt = useAppStateValue(
    useCallback((s) => s.completedSessionsByPaneKey[paneKey], [paneKey])
  )
  const setSessionCompleted = useAppStore((s) => s.setSessionCompleted)
  const isCompleted = isSessionMarkedComplete(completedAt, entry)
  const toggleCompleted = useCallback(() => {
    setSessionCompleted(paneKey, !isCompleted)
  }, [isCompleted, paneKey, setSessionCompleted])
  return { isCompleted, toggleCompleted }
}

export function SessionCompleteIndicator({
  size = 'sm',
  title,
  tooltipSide
}: {
  size?: 'sm' | 'md'
  title?: string | null
  tooltipSide?: StateIndicatorTooltipSide
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.SessionCompleteControls.completed', 'Completed')
  const box = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5'
  const icon = size === 'md' ? 'size-3' : 'size-2.5'
  return (
    <StateIndicatorTooltip label={title === null ? null : (title ?? label)} side={tooltipSide}>
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', box)}
        aria-label={label}
      >
        <CheckCheck className={cn('text-muted-foreground/75', icon)} aria-hidden="true" />
      </span>
    </StateIndicatorTooltip>
  )
}

export function SessionCompleteToggleButton({
  isCompleted,
  onToggle,
  className,
  iconClassName = 'size-3'
}: {
  isCompleted: boolean
  onToggle: () => void
  className?: string
  iconClassName?: string
}): React.JSX.Element {
  const t = useTranslate()
  const label = isCompleted
    ? t('auto.components.SessionCompleteControls.reopenSession', 'Reopen session')
    : t('auto.components.SessionCompleteControls.markComplete', 'Mark complete')
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onToggle()
    },
    [onToggle]
  )
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
  }, [])
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
    }
  }, [])
  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-xs text-muted-foreground/70 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      aria-label={label}
      title={label}
      data-session-complete-toggle=""
    >
      {isCompleted ? (
        <RotateCcw className={iconClassName} aria-hidden="true" />
      ) : (
        <CheckCheck className={iconClassName} aria-hidden="true" />
      )}
    </button>
  )
}
