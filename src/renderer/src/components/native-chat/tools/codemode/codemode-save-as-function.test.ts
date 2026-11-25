import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { askToSaveAsFunction, saveAsFunctionPrompt } from './codemode-save-as-function'

afterEach(clearNativeChatComposerDraftsForTests)

describe('saveAsFunctionPrompt', () => {
  it('prompt fences the code', () => {
    expect(saveAsFunctionPrompt('return 1')).toBe(
      'Save the script below as a saved function with lib.save: pick a clear camelCase name and a one-line description, and turn its hard-coded values into parameters. `source` must declare `async function <name>({...})` taking one object argument.\n\n```js\nreturn 1\n```'
    )
  })

  it('fence is longer than any backtick run in the code', () => {
    const code = 'const s = `a`\n// ```` inside'
    expect(saveAsFunctionPrompt(code).endsWith(`\n\n\`\`\`\`\`js\n${code}\n\`\`\`\`\``)).toBe(true)
  })
})

describe('askToSaveAsFunction', () => {
  it('appends to the chat draft', () => {
    const scope = structuredAgentSessionDraftScopeKey('s1')
    askToSaveAsFunction('s1', 'return 1')
    expect(readNativeChatComposerDraft(scope).text).toBe(saveAsFunctionPrompt('return 1'))
    askToSaveAsFunction('s1', 'return 2')
    expect(readNativeChatComposerDraft(scope).text).toContain('return 1')
    expect(readNativeChatComposerDraft(scope).text).toContain('return 2')
    expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('s2')).text).toBe('')
  })
})
