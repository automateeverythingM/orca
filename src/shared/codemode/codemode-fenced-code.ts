/**
 * `text` in a Markdown code fence longer than any backtick run inside it, so nothing in the text
 * can close the fence early. Inside a fence, HTML such as `<!-- -->` shows as typed instead of
 * hiding lines from the reader.
 */
export function fencedCode(text: string, lang = ''): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length)
  }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`
}
