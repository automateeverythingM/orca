import { useCallback, useId, useState } from 'react'
import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatUiCoarseRelativeTime } from '@/i18n/relative-time-format'
import type {
  CodemodeLibEntryView,
  CodemodeLibScope
} from '../../../../../shared/codemode/codemode-lib-types'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import { codemodeConnectorErrorMessage } from './codemode-connectors-client'
import {
  deleteCodemodeFunction,
  moveCodemodeFunction,
  trustCodemodeFunction,
  type CodemodeLibProject
} from './codemode-lib-client'
import { CodemodeFunctionSourceDialog } from './CodemodeFunctionSourceDialog'

type Busy = 'trust' | 'move' | 'delete' | null

function scopeLabel(scope: CodemodeLibScope, t: Translate): string {
  return scope === 'project'
    ? t('settings.codemode.functions.scopeProject', 'Project')
    : t('settings.codemode.functions.scopeGlobal', 'Global')
}

function usageLine(fn: CodemodeLibEntryView, now: number, t: Translate): string {
  const uses =
    fn.uses === 1
      ? t('settings.codemode.functions.usedOnce', 'Used once')
      : t('settings.codemode.functions.usedCount', 'Used {{count}} times', { count: fn.uses })
  if (fn.lastUsedAt === undefined) {
    return fn.uses === 0 ? t('settings.codemode.functions.neverUsed', 'Not used yet') : uses
  }
  return t('settings.codemode.functions.usedLast', '{{uses}}, last {{ago}}', {
    uses,
    ago: formatUiCoarseRelativeTime(fn.lastUsedAt - now)
  })
}

export function CodemodeFunctionRow({
  fn,
  projectRoot,
  onChanged
}: {
  fn: CodemodeLibEntryView
  projectRoot: CodemodeLibProject
  /** Reads the list again: a move, delete or allow changes more than this row. */
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { name, scope } = fn
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [viewing, setViewing] = useState(false)
  // Read once per mount, so the "last used" age holds still while the row is shown.
  const [now] = useState(() => Date.now())
  const target: CodemodeLibScope = scope === 'project' ? 'global' : 'project'

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (caught: unknown) {
      setError(codemodeConnectorErrorMessage(caught))
    }
    setBusy(null)
  }

  // The bytes the person read in View, tied to the listed hash they were read against: a reloaded
  // list with a changed file drops it, so Allow needs View again and never trusts unseen bytes.
  const [viewed, setViewed] = useState<{ listed: string; sha: string } | null>(null)
  const viewedSha = viewed?.listed === fn.sha256 ? viewed.sha : null
  const listedSha = fn.sha256
  const onViewedCurrent = useCallback(
    (sha: string) => setViewed({ listed: listedSha, sha }),
    [listedSha]
  )
  const allowHintId = useId()
  const allowViewFirst = t(
    'settings.codemode.functions.allowViewFirst',
    'Open View to read it first'
  )
  const trust = (): void => {
    if (viewedSha !== null) {
      void run('trust', () => trustCodemodeFunction(projectRoot, name, scope, viewedSha))
    }
  }
  const move = (): void =>
    void run('move', async () => {
      await moveCodemodeFunction(projectRoot, name, scope)
    })
  const remove = (): void =>
    void run('delete', async () => {
      await deleteCodemodeFunction(projectRoot, name, scope)
      setConfirmDelete(false)
    })

  return (
    <div data-settings-row="" className="space-y-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-48 space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm font-medium">{name}</span>
            <SettingsBadge tone={scope === 'project' ? 'accent' : 'neutral'} className="shrink-0">
              {scopeLabel(scope, t)}
            </SettingsBadge>
            {fn.trusted ? null : (
              <SettingsBadge className="shrink-0 border-status-warning-border bg-status-warning-background text-status-warning-text">
                {t('settings.codemode.functions.untrusted', 'Not allowed')}
              </SettingsBadge>
            )}
            {fn.shadowed ? (
              <SettingsBadge tone="muted" className="shrink-0">
                {t('settings.codemode.functions.shadowed', 'Hidden by project')}
              </SettingsBadge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground" title={fn.description}>
            {fn.description}
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">@{fn.savedBy}</span>
            {' · '}
            {usageLine(fn, now, t)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button variant="outline" size="xs" onClick={() => setViewing(true)}>
            {t('settings.codemode.functions.view', 'View')}
          </Button>
          {fn.trusted ? null : (
            <Button
              variant="outline"
              size="xs"
              disabled={busy === 'trust' || viewedSha === null}
              title={viewedSha === null ? allowViewFirst : undefined}
              aria-describedby={viewedSha === null ? allowHintId : undefined}
              onClick={trust}
            >
              {busy === 'trust' ? <Loader2 className="animate-spin" /> : null}
              {t('settings.codemode.functions.allow', 'Allow')}
            </Button>
          )}
          {fn.trusted || viewedSha !== null ? null : (
            <span id={allowHintId} className="sr-only">
              {allowViewFirst}
            </span>
          )}
          <Button
            variant="ghost"
            size="xs"
            disabled={busy === 'move' || (target === 'project' && !projectRoot)}
            onClick={move}
          >
            {busy === 'move' ? <Loader2 className="animate-spin" /> : null}
            {target === 'project'
              ? t('settings.codemode.functions.moveToProject', 'Move to project')
              : t('settings.codemode.functions.moveToGlobal', 'Move to global')}
          </Button>
          <Button
            variant="ghost-destructive"
            size="xs"
            aria-expanded={confirmDelete}
            onClick={() => setConfirmDelete(!confirmDelete)}
          >
            {t('settings.codemode.functions.delete', 'Delete')}
          </Button>
        </div>
      </div>
      {confirmDelete ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
            {t(
              'settings.codemode.functions.deleteConfirm',
              'Delete {{name}}? A copy stays in its history, and agents can no longer call it.',
              { name }
            )}
          </p>
          <Button variant="destructive" size="sm" disabled={busy === 'delete'} onClick={remove}>
            {busy === 'delete' ? <Loader2 className="animate-spin" /> : null}
            {t('settings.codemode.functions.delete', 'Delete')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
            {t('settings.codemode.functions.cancel', 'Cancel')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <CodemodeFunctionSourceDialog
        fn={fn}
        projectRoot={projectRoot}
        open={viewing}
        onOpenChange={setViewing}
        onViewedCurrent={onViewedCurrent}
      />
    </div>
  )
}
