import React, { useCallback, useRef, useState } from 'react'
import { Check, Play, Square, Terminal } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useNativeChatPaneLifetimeEffect } from '../../pane/ownership/native-chat-pane-lifetime'

export const CODE_RUN_ACTION_BUTTON_CLASS =
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
        className={cn(
          CODE_RUN_ACTION_BUTTON_CLASS,
          running && 'text-destructive hover:text-destructive'
        )}
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
      className={cn(CODE_RUN_ACTION_BUTTON_CLASS, opened && 'text-status-success')}
    >
      {opened ? <Check className="size-3.5" /> : <Terminal className="size-3.5" />}
    </button>
  )
}
