import { Check, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { formatToolDuration } from '../../../../../../shared/native-chat/tools/native-chat-tool-identity'
import { NativeChatExpandable } from '../../messages/disclosure/NativeChatExpandable'
import { useNativeChatDisclosure } from '../../messages/disclosure/native-chat-disclosure-store'
import type { CodemodeInnerCallRow } from './codemode-run-rows'

const PRE_CLASS =
  'max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-chat-code text-chat-foreground scrollbar-sleek'
const LABEL_CLASS =
  'mb-1 text-2xs font-semibold uppercase tracking-wider text-chat-foreground-faint'

function CallState({ call }: { call: CodemodeInnerCallRow }): React.JSX.Element {
  const t = useTranslate()
  if (call.state === 'running') {
    return (
      <span className="flex shrink-0 items-center text-chat-foreground-faint">
        <LoadingSpinner className="size-3.5" />
        <span className="sr-only">{t('components.native-chat.codemode.running', 'Running')}</span>
      </span>
    )
  }
  const failed = call.state === 'error'
  const Mark = failed ? X : Check
  return (
    <span
      className={cn(
        'flex shrink-0 items-center',
        failed ? 'text-destructive/70' : 'text-chat-foreground-faint'
      )}
    >
      <Mark aria-hidden className="size-3.5" />
      <span className="sr-only">
        {failed
          ? t('components.native-chat.codemode.failed', 'Failed')
          : t('components.native-chat.codemode.succeeded', 'Succeeded')}
      </span>
    </span>
  )
}

/** One call the script made: its tool, state and time, opening to its input and output. */
export function CodemodeInnerCallLine({
  call,
  disclosureKey
}: {
  call: CodemodeInnerCallRow
  disclosureKey?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  const duration = formatToolDuration(call.ms, (value0) =>
    t('components.native-chat.tool.milliseconds', '{{value0}}ms', { value0 })
  )
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group/codemode-call flex min-h-6 w-full items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate font-mono text-chat-code text-chat-foreground transition-colors group-hover/codemode-call:text-chat-foreground-strong">
          {call.tool}
        </span>
        <CallState call={call} />
        {duration ? (
          <span className="shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint">
            {duration}
          </span>
        ) : null}
        <ChevronRight
          className={cn(
            'ml-auto size-3.5 shrink-0 text-chat-foreground-faint transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      </button>
      <NativeChatExpandable open={open}>
        <div className="space-y-1.5 py-1">
          <div>
            <div className={LABEL_CLASS}>{t('components.native-chat.codemode.input', 'Input')}</div>
            <pre className={PRE_CLASS}>{call.input}</pre>
          </div>
          {call.output !== undefined ? (
            <div>
              <div className={LABEL_CLASS}>
                {call.state === 'error'
                  ? t('components.native-chat.codemode.error', 'Error')
                  : t('components.native-chat.codemode.output', 'Output')}
              </div>
              <pre className={cn(PRE_CLASS, call.state === 'error' && 'text-destructive')}>
                {call.output}
              </pre>
            </div>
          ) : null}
        </div>
      </NativeChatExpandable>
    </li>
  )
}
