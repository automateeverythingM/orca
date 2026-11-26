// Which repeated work Learn drafts a function for first. Pure.
import type {
  CodemodeRepeatedChain,
  CodemodeRepeatedScript
} from '../../../shared/codemode/codemode-learn-types'

export type CodemodeLearnSignal =
  | { kind: 'script'; script: CodemodeRepeatedScript }
  | { kind: 'chain'; chain: CodemodeRepeatedChain }

/** A signal's key: a script's shape or a chain's signature (the proposal's `sourceKey`). */
export const learnSignalKey = (signal: CodemodeLearnSignal): string =>
  signal.kind === 'script' ? signal.script.shape : signal.chain.signature

/** The best `limit` signals not in `skipKeys`. Score is chats x (tools - 1) (calls a function would
 *  save); chains count half, as they cannot be tested. Ties go to the more recently seen. */
export function pickSignals(
  scripts: CodemodeRepeatedScript[],
  chains: CodemodeRepeatedChain[],
  skipKeys: Set<string>,
  limit = 5
): CodemodeLearnSignal[] {
  const scored = [
    ...scripts.map((script) => ({
      signal: { kind: 'script', script } satisfies CodemodeLearnSignal,
      score: script.sessions * (script.tools.length - 1),
      lastSeen: script.lastSeen
    })),
    ...chains.map((chain) => ({
      signal: { kind: 'chain', chain } satisfies CodemodeLearnSignal,
      score: chain.sessions * (chain.tools.length - 1) * 0.5,
      lastSeen: chain.lastSeen
    }))
  ].filter((entry) => !skipKeys.has(learnSignalKey(entry.signal)))
  scored.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen)
  return scored.slice(0, limit).map((entry) => entry.signal)
}
