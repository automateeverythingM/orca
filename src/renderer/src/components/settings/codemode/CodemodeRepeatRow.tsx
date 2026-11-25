import { useEffect, useState } from 'react'
import type React from 'react'
import { Check, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatUiCoarseRelativeTime } from '@/i18n/relative-time-format'
import { codemodeErrorMessage } from './codemode-error-message'
import {
  dismissCodemodeRepeat,
  learnSaveRequest,
  type CodemodeRepeat
} from './codemode-learn-client'

const COPIED_MS = 2_000

function chatCount(count: number, t: Translate): string {
  return t('settings.codemode.learn.chats', '{{count}} chats', {
    count,
    defaultValue_one: '{{count}} chat'
  })
}

function scriptLine(repeat: CodemodeRepeat & { kind: 'script' }, now: number, t: Translate) {
  const runs = t('settings.codemode.learn.runs', '{{count}} runs', {
    count: repeat.runs,
    defaultValue_one: '{{count}} run'
  })
  const last = t('settings.codemode.learn.lastSeen', 'last {{ago}}', {
    ago: formatUiCoarseRelativeTime(repeat.lastSeen - now)
  })
  return `${chatCount(repeat.sessions, t)} · ${runs} · ${last}`
}

/** One script or tool chain agents repeated across chats, with its save request and Dismiss. */
export function CodemodeRepeatRow({
  repeat,
  onDismissed
}: {
  repeat: CodemodeRepeat
  /** Reads the list again once the repeat is dismissed. */
  onDismissed: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read once per mount, so the "last" age holds still while the row is shown.
  const [now] = useState(() => Date.now())

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    setError(null)
    try {
      await window.api.ui.writeClipboardText(learnSaveRequest(repeat))
      setCopied(true)
    } catch (caught: unknown) {
      setError(codemodeErrorMessage(caught))
    }
  }
  const dismiss = async (): Promise<void> => {
    setDismissing(true)
    setError(null)
    try {
      await dismissCodemodeRepeat(repeat)
      onDismissed()
    } catch (caught: unknown) {
      setError(codemodeErrorMessage(caught))
    }
    setDismissing(false)
  }

  return (
    <div data-settings-row="" className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-48 space-y-0.5">
          {repeat.kind === 'chain' ? (
            <p className="break-words font-mono text-sm font-medium">{repeat.tools.join(' → ')}</p>
          ) : (
            <p className="text-sm font-medium">
              {t('settings.codemode.learn.script', 'Script')}
              {repeat.tools.length > 0 ? (
                <span className="ml-2 break-words font-mono text-xs font-normal text-muted-foreground">
                  {repeat.tools.join(', ')}
                </span>
              ) : null}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {repeat.kind === 'chain' ? chatCount(repeat.sessions, t) : scriptLine(repeat, now, t)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button variant="outline" size="xs" onClick={() => void copy()}>
            {copied ? <Check /> : null}
            {copied
              ? t('settings.codemode.learn.copied', 'Copied')
              : t('settings.codemode.learn.copy', 'Copy save request')}
          </Button>
          <Button variant="ghost" size="xs" disabled={dismissing} onClick={() => void dismiss()}>
            {dismissing ? <Loader2 className="animate-spin" /> : null}
            {t('settings.codemode.learn.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
      {repeat.kind === 'script' ? (
        <div>
          <button
            type="button"
            aria-expanded={showCode}
            onClick={() => setShowCode(!showCode)}
            className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', showCode && 'rotate-90')}
            />
            {t('settings.codemode.learn.sampleCode', 'Sample code')}
          </button>
          {showCode ? (
            <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-xs scrollbar-sleek">
              {repeat.sampleCode}
            </pre>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
