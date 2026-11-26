import { useState } from 'react'
import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import type { CodemodeLearnProposal } from '../../../../../shared/codemode/codemode-learn-types'
import type { CodemodeLibScope } from '../../../../../shared/codemode/codemode-lib-types'
import { NativeChatHighlightedCode } from '../../native-chat/markdown/code/NativeChatHighlightedCode'
import { SettingsBadge, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { codemodeErrorMessage } from './codemode-error-message'
import { dismissCodemodeProposal, saveCodemodeProposal } from './codemode-learn-client'
import {
  canSaveProposal,
  defaultSaveScope,
  dismissKeepsRepeat,
  editedSource
} from './codemode-learn-proposal-view'
import { CODE_BOX, Disclosure, signalLine, TestLine } from './CodemodeLearnProposalParts'

/** One function Learn drafted: what it is, how its replay went, and Save / Edit / Dismiss. */
export function CodemodeLearnProposalCard({
  proposal,
  onChanged
}: {
  proposal: CodemodeLearnProposal
  /** Reads proposals and repeats again: a save or dismiss changes both. */
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [scope, setScope] = useState<CodemodeLibScope>(() => defaultSaveScope(proposal))
  const [edit, setEdit] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'dismiss' | null>(null)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = proposal.name ?? t('settings.codemode.learn.proposal.unnamed', 'New function')
  const working = proposal.state === 'writing' || proposal.state === 'testing'
  const saveable = canSaveProposal(proposal)
  // Why: the code shown and the source sent come from this one value, so what is read is saved.
  const shownSource = edit ?? proposal.source ?? ''
  const sentSource = editedSource(proposal, edit)
  const draftBlank = draft !== null && draft.trim() === ''

  const act = async (kind: 'save' | 'dismiss'): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      await (kind === 'dismiss'
        ? dismissCodemodeProposal(proposal.id)
        : saveCodemodeProposal({
            id: proposal.id,
            scope,
            ...(sentSource === undefined ? {} : { source: sentSource })
          }))
      // Why: stays busy until the refreshed list replaces this card, so there is no second click.
      onChanged()
    } catch (caught: unknown) {
      setError(codemodeErrorMessage(caught))
      setBusy(null)
    }
  }

  return (
    <div
      data-settings-row=""
      data-testid={`codemode-proposal-${proposal.id}`}
      className="space-y-2 py-3"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="break-all font-mono">{name}</span>
          {sentSource !== undefined ? (
            <SettingsBadge tone="muted">
              {t('settings.codemode.learn.proposal.edited', 'Edited')}
            </SettingsBadge>
          ) : null}
        </p>
        {proposal.description ? (
          <p className="break-words text-xs text-foreground/80">{proposal.description}</p>
        ) : null}
        <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <span>{signalLine(proposal, t)}</span>
          {proposal.callsSaved !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {t('settings.codemode.learn.proposal.callsSaved', 'Saves about {{count}} calls', {
                  count: proposal.callsSaved,
                  defaultValue_one: 'Saves about {{count}} call'
                })}
              </span>
            </>
          ) : null}
        </p>
      </div>
      {proposal.why ? (
        <p className="break-words text-xs text-muted-foreground">{proposal.why}</p>
      ) : null}
      {working ? (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {proposal.state === 'writing'
            ? t('settings.codemode.learn.proposal.writing', 'Writing a function…')
            : t('settings.codemode.learn.proposal.testing', 'Testing against recorded results…')}
        </p>
      ) : null}
      {proposal.state === 'failed' ? (
        <p className="break-words text-xs text-destructive">
          {proposal.source
            ? t(
                'settings.codemode.learn.proposal.notFinished',
                'Couldn’t finish testing: {{error}}',
                {
                  error: proposal.error ?? ''
                }
              )
            : t(
                'settings.codemode.learn.proposal.writeFailed',
                'Couldn’t write this function: {{error}}',
                {
                  error: proposal.error ?? ''
                }
              )}
        </p>
      ) : null}
      {proposal.state === 'ready' ? <TestLine proposal={proposal} /> : null}
      {proposal.testLog ? (
        <Disclosure label={t('settings.codemode.learn.proposal.testLog', 'Test log')}>
          <pre className={CODE_BOX}>{proposal.testLog}</pre>
        </Disclosure>
      ) : null}
      {draft !== null ? (
        <div className="space-y-1.5">
          <Textarea
            variant="code"
            aria-label={t('settings.codemode.learn.proposal.editLabel', 'Code for {{name}}', {
              name
            })}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-48"
          />
          <div className="flex flex-wrap items-center justify-end gap-1">
            {draftBlank ? (
              <p className="mr-auto text-xs text-destructive">
                {t('settings.codemode.learn.proposal.emptyCode', 'Code can’t be empty')}
              </p>
            ) : null}
            <Button variant="ghost" size="xs" onClick={() => setDraft(null)}>
              {t('settings.codemode.learn.cancel', 'Cancel')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={draftBlank}
              onClick={() => {
                setEdit(draft)
                setDraft(null)
              }}
            >
              {t('settings.codemode.learn.proposal.done', 'Done')}
            </Button>
          </div>
        </div>
      ) : proposal.source ? (
        <Disclosure label={t('settings.codemode.learn.proposal.code', 'Code')}>
          <pre data-native-chat-code-content className={CODE_BOX}>
            <NativeChatHighlightedCode code={shownSource} language="javascript" />
          </pre>
        </Disclosure>
      ) : null}
      {saveable && draft === null ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.codemode.learn.proposal.readFirst',
            'Replay checks one recorded case. Read the code before saving.'
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {saveable && draft === null ? (
          <>
            <Button variant="ghost" size="xs" onClick={() => setDraft(shownSource)}>
              {t('settings.codemode.learn.proposal.edit', 'Edit')}
            </Button>
            <SettingsSegmentedControl<CodemodeLibScope>
              size="sm"
              ariaLabel={t('settings.codemode.learn.proposal.scope', 'Save to')}
              value={scope}
              onChange={setScope}
              options={[
                {
                  value: 'project',
                  label: t('settings.codemode.functions.scopeProject', 'Project'),
                  disabled: proposal.projectRoot === null
                },
                { value: 'global', label: t('settings.codemode.functions.scopeGlobal', 'Global') }
              ]}
            />
            <Button size="xs" disabled={busy !== null} onClick={() => void act('save')}>
              {busy === 'save' ? <Loader2 className="animate-spin" /> : null}
              {t('settings.codemode.learn.proposal.save', 'Save')}
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={confirmDismiss}
          onClick={() => setConfirmDismiss(!confirmDismiss)}
        >
          {t('settings.codemode.learn.dismiss', 'Dismiss')}
        </Button>
      </div>
      {saveable && proposal.projectRoot === null ? (
        <p className="text-right text-xs text-muted-foreground">
          {t(
            'settings.codemode.learn.proposal.noProject',
            'These runs have no single project, so this saves as global.'
          )}
        </p>
      ) : null}
      {confirmDismiss ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
            {dismissKeepsRepeat(proposal)
              ? t(
                  'settings.codemode.learn.proposal.dismissRetry',
                  'Removes this card. A later Learn run may try again.'
                )
              : t('settings.codemode.learn.proposal.dismissConfirm', 'Won’t be suggested again.')}
          </p>
          <Button
            variant="destructive"
            size="xs"
            disabled={busy !== null}
            onClick={() => void act('dismiss')}
          >
            {busy === 'dismiss' ? <Loader2 className="animate-spin" /> : null}
            {t('settings.codemode.learn.dismiss', 'Dismiss')}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setConfirmDismiss(false)}>
            {t('settings.codemode.learn.cancel', 'Cancel')}
          </Button>
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
