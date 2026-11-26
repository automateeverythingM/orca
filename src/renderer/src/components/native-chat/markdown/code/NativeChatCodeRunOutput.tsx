import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  RotateCw,
  Square,
  Terminal,
  X,
  XCircle
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatCodeBlockRunDuration } from '../../../../../../shared/native-chat/code-block-run/native-chat-code-block-output'
import { NativeChatCopyButton } from '../../messages/actions/NativeChatCopyButton'
import { useNativeChatPaneLifetimeEffect } from '../../pane/ownership/native-chat-pane-lifetime'
import type { NativeChatCodeBlockRunRecord } from './native-chat-code-run-store'

const ACTION_BUTTON_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

export function NativeChatCodeRunControls({
  running,
  onRun,
  onStop,
  onOpenInTerminal
}: {
  running: boolean
  onRun: () => void
  onStop: () => void
  onOpenInTerminal?: () => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const runLabel = running
    ? t('components.native-chat.stopCommand', 'Stop command')
    : t('components.native-chat.runCommand', 'Run command')

  return (
    <>
      <button
        type="button"
        onClick={running ? onStop : onRun}
        aria-label={runLabel}
        title={runLabel}
        className={cn(ACTION_BUTTON_CLASS, running && 'text-destructive hover:text-destructive')}
      >
        {running ? <Square className="size-3 fill-current" /> : <Play className="size-3.5" />}
      </button>
      {onOpenInTerminal ? (
        <NativeChatCodeTerminalButton onOpenInTerminal={onOpenInTerminal} />
      ) : null}
    </>
  )
}

function NativeChatCodeTerminalButton({
  onOpenInTerminal
}: {
  onOpenInTerminal: () => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      return () => {
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current)
        }
      }
    }, [])
  )

  const handleOpen = useCallback(() => {
    if (opening) {
      return
    }
    setOpening(true)
    void onOpenInTerminal()
      .then((didOpen) => {
        if (!didOpen) {
          return
        }
        setOpened(true)
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current)
        }
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = null
          setOpened(false)
        }, 1500)
      })
      .finally(() => {
        setOpening(false)
      })
  }, [onOpenInTerminal, opening])

  const label = opened
    ? t('components.native-chat.ranInTerminal', 'Opened in terminal')
    : t('components.native-chat.openInTerminal', 'Open in terminal')

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={opening}
      aria-label={label}
      title={label}
      className={cn(ACTION_BUTTON_CLASS, opened && 'text-status-success')}
    >
      {opened ? <Check className="size-3.5" /> : <Terminal className="size-3.5" />}
    </button>
  )
}

export function NativeChatCodeRunOutput({
  record,
  expanded,
  onToggleExpanded,
  onRun,
  onStop,
  onClear
}: {
  record: NativeChatCodeBlockRunRecord
  expanded: boolean
  onToggleExpanded: () => void
  onRun: () => void
  onStop: () => void
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const outputRef = useRef<HTMLPreElement | null>(null)
  const pinnedToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = outputRef.current
    if (!el) {
      return
    }
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }, [])

  useEffect(() => {
    const el = outputRef.current
    if (!el || !expanded || !pinnedToBottomRef.current) {
      return
    }
    if (record.status === 'running') {
      el.scrollTop = el.scrollHeight
    }
  }, [expanded, record.output, record.status])

  const isRunning = record.status === 'running'
  const hasOutput = record.output.length > 0
  const hasError = Boolean(record.error)
  const showEmptyNotice = !isRunning && !hasOutput && !hasError
  const hasBody = hasOutput || hasError || showEmptyNotice

  const failureDetail =
    record.status === 'failed'
      ? record.exitCode !== null
        ? t('components.native-chat.exitCode', 'exit {{code}}', { code: record.exitCode })
        : record.signal
          ? record.signal
          : null
      : null

  return (
    <div
      data-native-chat-code-run-panel={record.status}
      className="border-t border-chat-code-border"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-chat-foreground-faint transition-colors hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <RunStatusBadge status={record.status} />
          {failureDetail ? (
            <span className="shrink-0 font-mono text-2xs text-destructive/80">{failureDetail}</span>
          ) : null}
          {record.durationMs !== null ? (
            <span className="shrink-0 font-mono text-2xs tabular-nums text-chat-foreground-faint">
              {formatCodeBlockRunDuration(record.durationMs)}
            </span>
          ) : null}
          {record.truncated ? (
            <span className="truncate text-2xs text-chat-foreground-faint">
              {t('components.native-chat.outputTruncated', 'showing latest output')}
            </span>
          ) : null}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('components.native-chat.stopCommand', 'Stop command')}
              title={t('components.native-chat.stopCommand', 'Stop command')}
              className={cn(ACTION_BUTTON_CLASS, 'text-destructive hover:text-destructive')}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              aria-label={t('components.native-chat.rerunCommand', 'Run again')}
              title={t('components.native-chat.rerunCommand', 'Run again')}
              className={ACTION_BUTTON_CLASS}
            >
              <RotateCw className="size-3.5" />
            </button>
          )}
          {hasOutput ? (
            <NativeChatCopyButton
              platformLineEndings
              text={record.output}
              label={t('components.native-chat.copyOutput', 'Copy output')}
            />
          ) : null}
          <button
            type="button"
            onClick={onClear}
            aria-label={t('components.native-chat.dismissOutput', 'Dismiss output')}
            title={t('components.native-chat.dismissOutput', 'Dismiss output')}
            className={ACTION_BUTTON_CLASS}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {expanded && hasBody ? (
        <div className="border-t border-chat-code-border/60 bg-chat-canvas/35">
          {hasOutput ? (
            <pre
              ref={outputRef}
              onScroll={handleScroll}
              data-native-chat-code-run-output
              className="scrollbar-sleek m-0 max-h-64 overflow-auto px-3.5 py-2.5 font-mono text-chat-code text-chat-code-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {record.output}
            </pre>
          ) : null}
          {hasError ? (
            <div
              data-native-chat-code-run-error
              className={cn(
                'px-3.5 py-2 font-mono text-chat-code text-destructive whitespace-pre-wrap [overflow-wrap:anywhere]',
                hasOutput && 'border-t border-chat-code-border/60'
              )}
            >
              {record.error}
            </div>
          ) : null}
          {showEmptyNotice ? (
            <div className="px-3.5 py-2 text-xs text-chat-foreground-faint">
              {t('components.native-chat.noCommandOutput', 'No output')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function RunStatusBadge({
  status
}: {
  status: NativeChatCodeBlockRunRecord['status']
}): React.JSX.Element {
  const t = useTranslate()
  if (status === 'running') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-chat-foreground">
        <Loader2 className="size-3.5 animate-spin text-chat-foreground-faint" />
        {t('components.native-chat.commandRunning', 'Running…')}
      </span>
    )
  }
  if (status === 'succeeded') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-status-success">
        <CheckCircle2 className="size-3.5" />
        {t('components.native-chat.commandSucceeded', 'Succeeded')}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-destructive">
        <XCircle className="size-3.5" />
        {t('components.native-chat.commandFailed', 'Failed')}
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-chat-foreground-faint">
      <Square className="size-3" />
      {t('components.native-chat.commandStopped', 'Stopped')}
    </span>
  )
}
