import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CodemodeLearnProposal,
  CodemodeLearnProposalUsage,
  CodemodeLearnProposalsView
} from '../../../../../shared/codemode/codemode-learn-types'
import { codemodeErrorMessage } from './codemode-error-message'
import { codemodeLearnProposals, proposeCodemodeLearn } from './codemode-learn-client'
import { proposeParams, splitProposals } from './codemode-learn-proposal-view'
import { CodemodeLearnProposalCard } from './CodemodeLearnProposalCard'

/** How often the list is read again while a Learn run is going. */
const POLL_MS = 2_000
const ALREADY_RUNNING = 'Learn is already running'

/** A function saved from a proposal, with how its use compares to the script it replaced. */
function SavedProposal({
  proposal,
  usage
}: {
  proposal: CodemodeLearnProposal
  usage: CodemodeLearnProposalUsage | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const saved = proposal.savedAs
  const parts = [
    saved?.scope === 'project'
      ? t('settings.codemode.learn.proposal.savedProject', 'Saved to project')
      : t('settings.codemode.learn.proposal.savedGlobal', 'Saved as global')
  ]
  if (usage) {
    parts.push(
      usage.uses === 1
        ? t('settings.codemode.functions.usedOnce', 'Used once')
        : t('settings.codemode.functions.usedCount', 'Used {{count}} times', { count: usage.uses })
    )
  }
  if (usage && usage.callsAfter !== null) {
    parts.push(
      t('settings.codemode.learn.proposal.callsChange', 'was {{before}} calls, now {{after}}', {
        before: proposal.callsBefore,
        after: usage.callsAfter
      })
    )
  }
  return (
    <div data-settings-row="" className="space-y-0.5 py-2.5">
      <p className="break-all font-mono text-sm">{saved?.name ?? proposal.name}</p>
      <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>
    </div>
  )
}

/** Settings › Learn's proposals: the button that starts a Learn run, and what it drafted. */
export function CodemodeLearnProposals({
  onChanged
}: {
  /** Reads the repeats again: dismissing a proposal also hides its repeat. */
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [view, setView] = useState<CodemodeLearnProposalsView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [hint, setHint] = useState('')
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const reads = useRef(0)

  const read = useCallback(() => {
    const id = ++reads.current
    void codemodeLearnProposals().then(
      (next) => {
        if (reads.current === id) {
          setView(next)
          setReadError(null)
        }
      },
      (caught: unknown) => {
        if (reads.current === id) {
          setReadError(codemodeErrorMessage(caught))
        }
      }
    )
  }, [])

  useEffect(() => {
    read()
    return () => {
      reads.current += 1
    }
  }, [read])

  // Why: each read sets a new view, so this schedules the next read for as long as the run goes.
  useEffect(() => {
    if (!view?.running) {
      return
    }
    const timer = setTimeout(read, POLL_MS)
    return () => clearTimeout(timer)
  }, [view, read])

  const changed = (): void => {
    read()
    onChanged()
  }
  const propose = async (): Promise<void> => {
    setAsking(true)
    setAskError(null)
    try {
      const result = await proposeCodemodeLearn(proposeParams(hint))
      if (result.started || result.reason === ALREADY_RUNNING) {
        setView((current) => (current ? { ...current, running: true } : current))
        read()
      } else {
        setAskError(result.reason)
      }
    } catch (caught: unknown) {
      setAskError(codemodeErrorMessage(caught))
    }
    setAsking(false)
  }

  const running = view?.running === true
  const { open, saved } = splitProposals(view?.proposals ?? [])
  const hintLabel = t('settings.codemode.learn.hint', 'What should Learn look for? (optional)')

  return (
    <>
      <div data-settings-row="" className="space-y-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={hint}
            onChange={(event) => setHint(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !running && !asking) {
                void propose()
              }
            }}
            placeholder={hintLabel}
            aria-label={hintLabel}
            maxLength={2000}
            className="h-8 min-w-0 flex-1 basis-56"
          />
          <Button size="xs" disabled={running || asking} onClick={() => void propose()}>
            {running || asking ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {running
              ? t('settings.codemode.learn.learning', 'Learning…')
              : t('settings.codemode.learn.propose', 'Find functions to save')}
          </Button>
        </div>
        {askError ? (
          <p role="alert" className="text-xs text-destructive">
            {askError}
          </p>
        ) : null}
        {readError ? (
          <p role="alert" className="text-xs text-destructive">
            {readError}
          </p>
        ) : null}
      </div>
      {open.map((proposal) => (
        <CodemodeLearnProposalCard key={proposal.id} proposal={proposal} onChanged={changed} />
      ))}
      {saved.length > 0 ? (
        <>
          <p data-settings-row="" className="pt-3 pb-1 text-xs font-medium text-muted-foreground">
            {t('settings.codemode.learn.savedByLearn', 'Saved by Learn')}
          </p>
          {saved.map((proposal) => (
            <SavedProposal key={proposal.id} proposal={proposal} usage={view?.usage[proposal.id]} />
          ))}
        </>
      ) : null}
    </>
  )
}
