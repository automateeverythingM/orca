import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { askToSaveAsFunction, saveAsFunctionPrompt } from './codemode-save-as-function'

afterEach(clearNativeChatComposerDraftsForTests)

describe('saveAsFunctionPrompt', () => {
  it('prompt fences the code', () => {
    expect(saveAsFunctionPrompt('return 1')).toBe(
      'Save the script below as a saved function with lib.save: pick a clear camelCase name and a one-line description, and turn its hard-coded values into parameters.\n\n```js\nreturn 1\n```'
    )
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
