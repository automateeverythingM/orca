// Small pieces of a Learn proposal card: its signal line, replay result and disclosures.
import { useState } from 'react'
import type React from 'react'
import { Check, ChevronRight, CircleAlert, CircleHelp } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CodemodeLearnProposal } from '../../../../../shared/codemode/codemode-learn-types'

export const CODE_BOX =
  'mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-xs scrollbar-sleek'

export function signalLine(proposal: CodemodeLearnProposal, t: Translate): string {
  const count = proposal.sourceSessions
  return proposal.sourceKind === 'chain'
    ? t('settings.codemode.learn.proposal.chainSignal', 'Tool chain used in {{count}} chats', {
        count,
        defaultValue_one: 'Tool chain used in {{count}} chat'
      })
    : t('settings.codemode.learn.proposal.scriptSignal', 'Script used in {{count}} chats', {
        count,
        defaultValue_one: 'Script used in {{count}} chat'
      })
}

/** Passed / Failed: reason / Untested: reason, once a replay result is in. */
export function TestLine({
  proposal
}: {
  proposal: CodemodeLearnProposal
}): React.JSX.Element | null {
  const t = useTranslate()
  const reason = proposal.testReason ?? ''
  switch (proposal.testStatus) {
    case 'passed':
      return (
        <p className="flex items-center gap-1 text-xs text-foreground">
          <Check className="size-3.5 shrink-0" />
          <span>{t('settings.codemode.learn.proposal.passed', 'Passed')}</span>
        </p>
      )
    case 'failed':
      return (
        <p className="flex items-start gap-1 break-words text-xs text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            {t('settings.codemode.learn.proposal.testFailed', 'Failed: {{reason}}', { reason })}
          </span>
        </p>
      )
    case 'untested':
      return (
        <p className="flex items-start gap-1 break-words text-xs text-muted-foreground">
          <CircleHelp className="mt-px size-3.5 shrink-0" />
          <span>
            {t('settings.codemode.learn.proposal.untested', 'Untested: {{reason}}', { reason })}
          </span>
        </p>
      )
    case undefined:
      return null
  }
}

export function Disclosure({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open ? children : null}
    </div>
  )
}
