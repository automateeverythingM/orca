import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { codemodeErrorMessage } from '../../../settings/codemode/codemode-error-message'
import { proposeCodemodeLearn } from '../../../settings/codemode/codemode-learn-client'

type Ask =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'started' }
  /** Nothing to draft (every repeat here already has a proposal): a note, not an error. */
  | { kind: 'nothing-new'; reason: string }
  | { kind: 'refused'; reason: string }

/** The "Ran in N chats" badge's action: a Learn run over this chat's runs of this one script. */
export function CodemodeLearnFromThis({
  sessionId,
  shape
}: {
  sessionId: string
  shape: string
}): React.JSX.Element {
  const t = useTranslate()
  const [ask, setAsk] = useState<Ask>({ kind: 'idle' })

  const learn = async (): Promise<void> => {
    setAsk({ kind: 'asking' })
    try {
      const result = await proposeCodemodeLearn({ sessionId, shape })
      if (result.started) {
        setAsk({ kind: 'started' })
      } else {
        setAsk({
          kind: result.code === 'nothing-new' ? 'nothing-new' : 'refused',
          reason: result.reason
        })
      }
    } catch (caught: unknown) {
      setAsk({ kind: 'refused', reason: codemodeErrorMessage(caught) })
    }
  }

  if (ask.kind === 'started') {
    return (
      <span role="status" className="text-chat-foreground-faint">
        {t(
          'components.native-chat.codemode.learnStarted',
          'Learning… see Settings › Code mode › Learn'
        )}
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        disabled={ask.kind === 'asking'}
        onClick={() => void learn()}
        className="flex items-center gap-1.5 rounded-md py-1 text-chat-foreground-faint transition-colors hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        {ask.kind === 'asking' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
        {t('components.native-chat.codemode.learnFromThis', 'Learn from this')}
      </button>
      {ask.kind === 'nothing-new' ? (
        <span role="status" className="text-chat-foreground-faint">
          {ask.reason}
        </span>
      ) : null}
      {ask.kind === 'refused' ? (
        <span role="alert" className="text-destructive">
          {ask.reason}
        </span>
      ) : null}
    </>
  )
}
