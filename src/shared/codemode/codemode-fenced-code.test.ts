import { describe, expect, it } from 'vitest'
import { fencedCode } from './codemode-fenced-code'

describe('fencedCode', () => {
  it('fences plain text with three backticks', () => {
    expect(fencedCode('return 1', 'js')).toBe('```js\nreturn 1\n```')
    expect(fencedCode('return 1\n', 'js')).toBe('```js\nreturn 1\n```')
  })

  it('uses a fence longer than the longest backtick run inside', () => {
    expect(fencedCode('a ``` b\n`````', 'js')).toBe('``````js\na ``` b\n`````\n``````')
    expect(fencedCode('x = `t`')).toBe('```\nx = `t`\n```')
  })
})
