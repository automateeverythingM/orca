import { useMemo } from 'react'
import { ChevronRight, Save } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import type { CodemodeRunRecord } from '../../../../../../shared/codemode/codemode-run-wire'
import { codemodeCallCode } from '../../../../../../shared/codemode/codemode-run-match'
import { formatToolDuration } from '../../../../../../shared/native-chat/tools/native-chat-tool-identity'
import { NativeChatExpandable } from '../../messages/disclosure/NativeChatExpandable'
import { useNativeChatDisclosure } from '../../messages/disclosure/native-chat-disclosure-store'
import { NativeChatHighlightedCode } from '../../markdown/code/NativeChatHighlightedCode'
import { NativeChatToolIcon } from '../lines/NativeChatToolIcon'
import { NativeChatToolOutput } from '../lines/NativeChatToolOutput'
import { CodemodeInnerCallLine } from './CodemodeInnerCallLine'
import { CodemodeLearnFromThis } from './CodemodeLearnFromThis'
import { codemodeCodePreview, codemodeInnerCallRows, codemodeRunCall } from './codemode-run-rows'
import { askToSaveAsFunction } from './codemode-save-as-function'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import { useCodemodeRun } from './use-codemode-run'

/** A run_js call: the script behind its own disclosure, then each call it made as it happens. */
export function CodemodeRunView({
  block,
  result,
  run,
  disclosureKey
}: {
  block: NativeChatToolCallBlock
  result: NativeChatToolResultBlock | undefined
  /** The host's record of this call's run; null when it has none to give. */
  run: CodemodeRunRecord | null
  disclosureKey?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  const code = codemodeCallCode(block.input)
  const calls = useMemo(() => codemodeInnerCallRows(run), [run])
  const failed = block.state === 'failed' || result?.isError === true || run?.state === 'error'
  const duration = formatToolDuration(run?.ms ?? block.durationMs, (value0) =>
    t('components.native-chat.tool.milliseconds', '{{value0}}ms', { value0 })
  )
  const sessionId = useNativeChatVisualOwner()?.sessionId
  const canSave =
    sessionId !== undefined &&
    code !== null &&
    !failed &&
    block.state !== 'running' &&
    run?.state !== 'running' &&
    run?.codeTruncated !== true
  const callCount = calls.length + (run?.omittedCalls ?? 0)
  // Learn's count of chats that ran this same script, this one included.
  const seenInChats = run?.seenInChats ?? 0

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group/tool-line flex min-h-6.5 w-full items-center gap-2 rounded-md text-left font-sans text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <NativeChatToolIcon
          mcpIdentity={block.mcpIdentity}
          rowWord={block.name}
          input={block.input}
          className={failed ? 'text-destructive/70' : 'text-chat-foreground-faint'}
        />
        <span className="shrink-0 text-chat-foreground-faint transition-colors group-hover/tool-line:text-chat-foreground">
          {t('components.native-chat.codemode.script', 'Script')}
        </span>
        <span className="min-w-0 truncate font-mono text-chat-code text-chat-foreground transition-colors group-hover/tool-line:text-chat-foreground-strong">
          {codemodeCodePreview(code)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-sans text-xs tabular-nums text-chat-foreground-faint">
          {callCount > 0 ? (
            <span>
              {t('components.native-chat.codemode.callCount', '{{count}} calls', {
                count: callCount,
                defaultValue_one: '{{count}} call'
              })}
            </span>
          ) : null}
          {duration ? <span>{duration}</span> : null}
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
          />
        </span>
      </button>
      <NativeChatExpandable open={open}>
        <div className="ml-6 space-y-1.5 py-1">
          <pre
            data-native-chat-code-content
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-chat-code text-chat-foreground scrollbar-sleek"
          >
            <NativeChatHighlightedCode code={code ?? ''} language="javascript" />
          </pre>
          {result ? <NativeChatToolOutput body={result} /> : null}
          {canSave || seenInChats >= 2 ? (
            <div className="flex flex-wrap items-center gap-x-3 font-sans text-xs">
              {canSave ? (
                <button
                  type="button"
                  onClick={() => askToSaveAsFunction(sessionId, code)}
                  className="flex items-center gap-1.5 rounded-md py-1 text-chat-foreground-faint transition-colors hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Save className="size-3.5" />
                  {t('components.native-chat.codemode.saveAsFunction', 'Save as function')}
                </button>
              ) : null}
              {seenInChats >= 2 ? (
                <span className="text-chat-foreground-faint">
                  {t('components.native-chat.codemode.seenInChats', 'Ran in {{count}} chats', {
                    count: seenInChats
                  })}
                </span>
              ) : null}
              {seenInChats >= 2 && sessionId !== undefined && run?.shape ? (
                <CodemodeLearnFromThis sessionId={sessionId} shape={run.shape} />
              ) : null}
            </div>
          ) : null}
        </div>
      </NativeChatExpandable>
      {calls.length > 0 || (run?.omittedCalls ?? 0) > 0 ? (
        <ul className="ml-6 pb-0.5">
          {calls.map((call) => (
            <CodemodeInnerCallLine
              key={call.key}
              call={call}
              disclosureKey={
                disclosureKey === undefined ? undefined : `${disclosureKey}:call:${call.seq}`
              }
            />
          ))}
          {run && run.omittedCalls > 0 ? (
            <li className="min-h-6 py-0.5 text-xs text-chat-foreground-faint">
              {t('components.native-chat.codemode.omitted', '{{count}} more calls not shown', {
                count: run.omittedCalls,
                defaultValue_one: '{{count}} more call not shown'
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/** The run_js row as the transcript draws it, reading its run from the session's host. */
export function CodemodeRunLine({
  block,
  result,
  lineIdentity,
  disclosureKey
}: {
  block: NativeChatToolCallBlock
  result: NativeChatToolResultBlock | undefined
  lineIdentity: string
  disclosureKey?: string
}): React.JSX.Element {
  const call = useMemo(
    () => codemodeRunCall(block, result, lineIdentity),
    [block, result, lineIdentity]
  )
  const run = useCodemodeRun(call)
  return <CodemodeRunView block={block} result={result} run={run} disclosureKey={disclosureKey} />
}
