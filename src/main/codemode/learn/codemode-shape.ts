import { createHash } from 'node:crypto'

// Why: Learn must match scripts that differ only in literal values, so we
// reduce code to a token stream with literals collapsed to `_`.
const REGEX_PRECEDING_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await'
])
const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**'
]
const IDENT_START = /[A-Za-z_$\u0080-￿]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/
const DIGIT = /[0-9]/

function isIdentifier(token: string | undefined): boolean {
  return token !== undefined && IDENT_START.test(token[0]) && !REGEX_PRECEDING_WORDS.has(token)
}

function regexAllowed(prev: string | undefined): boolean {
  if (prev === undefined) {
    return true
  }
  if (REGEX_PRECEDING_WORDS.has(prev)) {
    return true
  }
  if (IDENT_START.test(prev[0]) || DIGIT.test(prev[0]) || prev === '_') {
    return false
  }
  return prev !== ')' && prev !== ']' && prev !== '}'
}

class Scanner {
  readonly tokens: string[] = []
  private i = 0

  constructor(private readonly src: string) {}

  run(): string[] {
    this.scan(false)
    return this.tokens
  }

  // Returns when input ends or, in template-expression mode, at the matching `}`.
  private scan(inTemplateExpr: boolean): void {
    const { src } = this
    let depth = 0
    while (this.i < src.length) {
      const c = src[this.i]
      const next = src[this.i + 1]
      if (/\s/.test(c)) {
        this.i++
      } else if (c === '/' && next === '/') {
        while (this.i < src.length && src[this.i] !== '\n') {
          this.i++
        }
      } else if (c === '/' && next === '*') {
        const end = src.indexOf('*/', this.i + 2)
        this.i = end === -1 ? src.length : end + 2
      } else if (c === '"' || c === "'") {
        this.string(c)
      } else if (c === '`') {
        this.template()
      } else if (c === '/' && regexAllowed(this.tokens.at(-1))) {
        this.regex()
      } else if (DIGIT.test(c) || (c === '.' && next !== undefined && DIGIT.test(next))) {
        this.number()
      } else if (IDENT_START.test(c)) {
        const start = this.i
        while (this.i < src.length && IDENT_PART.test(src[this.i])) {
          this.i++
        }
        this.tokens.push(src.slice(start, this.i))
      } else {
        if (inTemplateExpr) {
          if (c === '{') {
            depth++
          } else if (c === '}') {
            if (depth === 0) {
              this.i++
              this.tokens.push('}')
              return
            }
            depth--
          }
        }
        const punct = PUNCTUATORS.find((p) => src.startsWith(p, this.i)) ?? c
        this.i += punct.length
        this.tokens.push(punct)
      }
    }
  }

  private string(quote: string): void {
    const { src } = this
    const start = this.i
    this.i++
    while (this.i < src.length && src[this.i] !== quote) {
      this.i += src[this.i] === '\\' ? 2 : 1
    }
    this.i = Math.min(this.i + 1, src.length)
    const text = src.slice(start, this.i)
    this.tokens.push(this.isBracketKey(text) ? text : '_')
  }

  private isBracketKey(text: string): boolean {
    const n = this.tokens.length
    if (this.tokens[n - 1] !== '[' || n < 2) {
      return false
    }
    const before = this.tokens[n - 2]
    if (!isIdentifier(before) && before !== ')' && before !== ']') {
      return false
    }
    let j = this.i
    while (j < this.src.length && /\s/.test(this.src[j])) {
      j++
    }
    return this.src[j] === ']' && text.length >= 2
  }

  private template(): void {
    const { src } = this
    this.i++
    this.tokens.push('_')
    while (this.i < src.length) {
      const c = src[this.i]
      if (c === '\\') {
        this.i += 2
      } else if (c === '`') {
        this.i++
        return
      } else if (c === '$' && src[this.i + 1] === '{') {
        this.i += 2
        this.tokens.push('${')
        this.scan(true)
      } else {
        this.i++
      }
    }
  }

  private regex(): void {
    const { src } = this
    this.i++
    let inClass = false
    while (this.i < src.length && src[this.i] !== '\n') {
      const c = src[this.i]
      if (c === '\\') {
        this.i += 2
        continue
      }
      this.i++
      if (c === '[') {
        inClass = true
      } else if (c === ']') {
        inClass = false
      } else if (c === '/' && !inClass) {
        break
      }
    }
    while (this.i < src.length && IDENT_PART.test(src[this.i])) {
      this.i++
    }
    this.tokens.push('_')
  }

  private number(): void {
    const { src } = this
    while (this.i < src.length && (IDENT_PART.test(src[this.i]) || src[this.i] === '.')) {
      this.i++
    }
    this.tokens.push('_')
  }
}

export function codemodeShapeTokens(code: string): string[] {
  return new Scanner(code).run()
}

export function codemodeShapeHash(code: string): string {
  return createHash('sha256').update(codemodeShapeTokens(code).join(' ')).digest('hex')
}
