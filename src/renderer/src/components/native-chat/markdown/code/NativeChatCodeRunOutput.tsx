import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Loader2,
  RotateCw,
  Square,
  X,
  XCircle
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatCodeBlockRunDuration } from '../../../../../../shared/native-chat/code-block-run/native-chat-code-block-output'
import { NativeChatCopyButton } from '../../messages/actions/NativeChatCopyButton'
import { useNativeChatPaneLifetimeEffect } from '../../pane/ownership/native-chat-pane-lifetime'
import { CODE_RUN_ACTION_BUTTON_CLASS } from './NativeChatCodeRunControls'
import type { NativeChatCodeBlockRunRecord } from './native-chat-code-run-store'

export function NativeChatCodeRunOutput({
  record,
  expanded,
  onToggleExpanded,
  onRun,
  onStop,
  onClear,
  onSendToChat
}: {
  record: NativeChatCodeBlockRunRecord
  expanded: boolean
  onToggleExpanded: () => void
  onRun: () => void
  onStop: () => void
  onClear: () => void
  onSendToChat?: () => boolean
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
  const isFailed = record.status === 'failed'
  const hasOutput = record.output.length > 0
  const hasError = Boolean(record.error)
  const showEmptyNotice = !isRunning && !hasOutput && !hasError
  const hasBody = hasOutput || hasError || showEmptyNotice

  const failureDetail = isFailed
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
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-chat-foreground-faint transition-colors hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          {!isRunning && onSendToChat ? (
            <SendRunResultButton failed={isFailed} onSend={onSendToChat} />
          ) : null}
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('components.native-chat.stopCommand', 'Stop command')}
              title={t('components.native-chat.stopCommand', 'Stop command')}
              className={cn(
                CODE_RUN_ACTION_BUTTON_CLASS,
                'text-destructive hover:text-destructive'
              )}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              aria-label={t('components.native-chat.rerunCommand', 'Run again')}
              title={t('components.native-chat.rerunCommand', 'Run again')}
              className={CODE_RUN_ACTION_BUTTON_CLASS}
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
            className={CODE_RUN_ACTION_BUTTON_CLASS}
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

function SendRunResultButton({
  failed,
  onSend
}: {
  failed: boolean
  onSend: () => boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [sent, setSent] = useState(false)
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

  const handleClick = useCallback(() => {
    if (!onSend()) {
      return
    }
    setSent(true)
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      setSent(false)
    }, 1500)
  }, [onSend])

  if (failed) {
    const label = sent
      ? t('components.native-chat.sentToAgent', 'Sent to agent')
      : t('components.native-chat.fixWithAgent', 'Fix with agent')
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className={cn(
          'mr-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-chat-code-border bg-chat-canvas/60 px-2 text-xs font-medium text-chat-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          sent && 'text-status-success'
        )}
      >
        {sent ? <Check className="size-3" /> : <CornerDownLeft className="size-3" />}
        <span>{label}</span>
      </button>
    )
  }

  const label = sent
    ? t('components.native-chat.sentToAgent', 'Sent to agent')
    : t('components.native-chat.sendOutputToChat', 'Send result to chat')

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn(CODE_RUN_ACTION_BUTTON_CLASS, sent && 'text-status-success')}
    >
      {sent ? <Check className="size-3.5" /> : <CornerDownLeft className="size-3.5" />}
    </button>
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
