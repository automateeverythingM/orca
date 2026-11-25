import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CodemodeLearnListView,
  CodemodeLearnStatusView
} from '../../../../../shared/codemode/codemode-learn-types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { codemodeErrorMessage } from './codemode-error-message'
import {
  clearCodemodeLearn,
  codemodeLearnStatus,
  listCodemodeRepeats
} from './codemode-learn-client'
import { CODEMODE_LEARN_TARGET_ID, getCodemodeLearnSearchEntry } from './codemode-settings-search'
import { CodemodeRepeatRow } from './CodemodeRepeatRow'

type LearnState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: CodemodeLearnStatusView; list: CodemodeLearnListView }

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

/** Settings › Code mode › Learn: the switch, what is stored, and the work agents repeat. */
export function CodemodeLearnSection({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getCodemodeLearnSearchEntry()
  const enabled = settings.codemodeLearnEnabled === true
  const [state, setState] = useState<LearnState>({ kind: 'loading' })
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const reads = useRef(0)

  const refresh = useCallback(() => {
    const read = ++reads.current
    void Promise.all([codemodeLearnStatus(), listCodemodeRepeats()]).then(
      ([status, list]) => {
        if (reads.current === read) {
          setState({ kind: 'ready', status, list })
        }
      },
      (caught: unknown) => {
        if (reads.current === read) {
          setState({ kind: 'error', message: codemodeErrorMessage(caught) })
        }
      }
    )
  }, [])

  // Why: main reads the switch from saved settings, so read again once a change is saved.
  useEffect(() => {
    refresh()
    return () => {
      reads.current += 1
    }
  }, [refresh, enabled])

  const toggle = (): void => {
    void Promise.resolve(updateSettings({ codemodeLearnEnabled: !enabled })).then(refresh, refresh)
  }
  const clear = async (): Promise<void> => {
    setClearing(true)
    setClearError(null)
    try {
      await clearCodemodeLearn()
      setConfirmClear(false)
      refresh()
    } catch (caught: unknown) {
      setClearError(codemodeErrorMessage(caught))
    }
    setClearing(false)
  }

  const ready = state.kind === 'ready' ? state : null
  const stats = ready?.status.stats
  // Why: an emptied store file still has a size; with the switch off only stored runs are worth a line.
  const showStats = stats !== undefined && (enabled || stats.runs > 0)
  const repeats = ready ? [...ready.list.scripts, ...ready.list.chains] : []
  const muted = 'py-3 text-xs text-muted-foreground'

  return (
    <SettingsGroup
      id={CODEMODE_LEARN_TARGET_ID}
      title={entry.title}
      description={entry.description}
    >
      <SettingsSwitchRow
        label={t('settings.codemode.learn.switch', 'Learn from code mode runs')}
        description={t(
          'settings.codemode.learn.switchDescription',
          'Keeps your scripts and their results on this computer for 30 days to find work you repeat.'
        )}
        checked={enabled}
        onChange={toggle}
      />
      {showStats ? (
        <div data-settings-row="" className="space-y-2 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t('settings.codemode.learn.stats', '{{count}} runs recorded, {{size}} MB', {
                count: stats.runs,
                size: megabytes(stats.bytes),
                defaultValue_one: '{{count}} run recorded, {{size}} MB'
              })}
            </p>
            <Button
              variant="ghost-destructive"
              size="xs"
              aria-expanded={confirmClear}
              onClick={() => setConfirmClear(!confirmClear)}
            >
              {t('settings.codemode.learn.clear', 'Clear')}
            </Button>
          </div>
          {confirmClear ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
                {t(
                  'settings.codemode.learn.clearConfirm',
                  'Delete every recorded run and its results from this computer? Dismissed repeats come back.'
                )}
              </p>
              <Button
                variant="destructive"
                size="sm"
                disabled={clearing}
                onClick={() => void clear()}
              >
                {clearing ? <Loader2 className="animate-spin" /> : null}
                {t('settings.codemode.learn.clear', 'Clear')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                {t('settings.codemode.learn.cancel', 'Cancel')}
              </Button>
            </div>
          ) : null}
          {clearError ? (
            <p role="alert" className="text-xs text-destructive">
              {clearError}
            </p>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'loading' ? (
        <p data-settings-row="" role="status" className={muted}>
          {t('settings.codemode.learn.reading', 'Reading repeated work…')}
        </p>
      ) : state.kind === 'error' ? (
        <div data-settings-row="" className="flex flex-wrap items-center gap-2 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {state.message}
          </p>
          <Button variant="outline" size="xs" onClick={refresh}>
            {t('settings.codemode.learn.retry', 'Try again')}
          </Button>
        </div>
      ) : !enabled ? (
        <p data-settings-row="" className={muted}>
          {t('settings.codemode.learn.off', 'Turn on Learn to find scripts you repeat.')}
        </p>
      ) : repeats.length === 0 ? (
        <p data-settings-row="" className={muted}>
          {t(
            'settings.codemode.learn.empty',
            'Nothing repeated yet. Scripts and tool chains used in 2 or more chats show up here.'
          )}
        </p>
      ) : (
        repeats.map((repeat) => (
          <CodemodeRepeatRow
            key={repeat.kind === 'script' ? `s:${repeat.shape}` : `c:${repeat.signature}`}
            repeat={repeat}
            onDismissed={refresh}
          />
        ))
      )}
    </SettingsGroup>
  )
}
