import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useActiveWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import type { CodemodeLibListView } from '../../../../../shared/codemode/codemode-lib-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { codemodeConnectorErrorMessage } from './codemode-connectors-client'
import { listCodemodeFunctions } from './codemode-lib-client'
import { CodemodeFunctionRow } from './CodemodeFunctionRow'
import {
  CODEMODE_FUNCTIONS_TARGET_ID,
  getCodemodeFunctionsSearchEntry
} from './codemode-settings-search'

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | ({ kind: 'ready' } & CodemodeLibListView)

/** Saved functions of the active worktree (project scope) and of this computer (global scope). */
export function CodemodeFunctionList(): React.JSX.Element {
  const t = useTranslate()
  const entry = getCodemodeFunctionsSearchEntry()
  const worktree = useActiveWorktree()
  const projectRoot = worktree?.path ?? null
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const reads = useRef(0)

  const refresh = useCallback(() => {
    const read = ++reads.current
    void listCodemodeFunctions(projectRoot).then(
      (view) => {
        if (reads.current === read) {
          setState({ kind: 'ready', ...view })
        }
      },
      (caught: unknown) => {
        if (reads.current === read) {
          setState({ kind: 'error', message: codemodeConnectorErrorMessage(caught) })
        }
      }
    )
  }, [projectRoot])

  useEffect(() => {
    refresh()
    return () => {
      reads.current += 1
    }
  }, [refresh])

  return (
    <SettingsGroup
      id={CODEMODE_FUNCTIONS_TARGET_ID}
      title={entry.title}
      description={entry.description}
    >
      <p data-settings-row="" className="py-2 text-xs text-muted-foreground">
        {worktree
          ? t(
              'settings.codemode.functions.projectFrom',
              'Project functions come from {{name}} (the open worktree).',
              { name: worktree.displayName }
            )
          : t(
              'settings.codemode.functions.noProject',
              'No worktree is open, so only global functions show.'
            )}
      </p>
      {state.kind === 'loading' ? (
        <p data-settings-row="" role="status" className="py-3 text-xs text-muted-foreground">
          {t('settings.codemode.functions.reading', 'Reading saved functions…')}
        </p>
      ) : state.kind === 'error' ? (
        <div data-settings-row="" className="flex flex-wrap items-center gap-2 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {state.message}
          </p>
          <Button variant="outline" size="xs" onClick={refresh}>
            {t('settings.codemode.functions.retry', 'Try again')}
          </Button>
        </div>
      ) : (
        <>
          {state.functions.length === 0 ? (
            <p data-settings-row="" className="py-3 text-xs text-muted-foreground">
              {t(
                'settings.codemode.functions.empty',
                'No saved functions yet. Agents save them with lib.save, or use “Save as function” on a finished script.'
              )}
            </p>
          ) : (
            state.functions.map((fn) => (
              <CodemodeFunctionRow
                key={`${fn.scope}:${fn.name}`}
                fn={fn}
                projectRoot={projectRoot}
                onChanged={refresh}
              />
            ))
          )}
          {state.problems.length > 0 ? (
            <div data-settings-row="" className="space-y-1 py-3">
              <p className="text-xs font-medium text-status-warning-text">
                {t('settings.codemode.functions.problems', 'These files were skipped:')}
              </p>
              <ul className="space-y-0.5">
                {state.problems.map((problem) => (
                  <li key={problem} className="break-all font-mono text-xs text-muted-foreground">
                    {problem}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </SettingsGroup>
  )
}
