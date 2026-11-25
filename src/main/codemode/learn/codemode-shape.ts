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
const MAX_TEMPLATE_DEPTH = 64

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
  private templateDepth = 0

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
    const closed = this.i - start >= 2 && src[this.i - 1] === quote
    this.tokens.push(
      closed && this.isBracketKey() ? this.keyToken(src.slice(start + 1, this.i - 1)) : '_'
    )
  }

  // Why: m["a"], m['a'] and m[`a`] are the same member, so they share one token.
  private keyToken(inner: string): string {
    return `'${inner}'`
  }

  private isBracketKey(placeholders = 0): boolean {
    const n = this.tokens.length - placeholders
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
    return this.src[j] === ']'
  }

  private template(): void {
    const { src } = this
    const start = this.i + 1
    this.i++
    this.tokens.push('_')
    let plain = true
    while (this.i < src.length) {
      const c = src[this.i]
      if (c === '\\') {
        this.i += 2
      } else if (c === '`') {
        this.i++
        if (plain && this.isBracketKey(1)) {
          this.tokens[this.tokens.length - 1] = this.keyToken(src.slice(start, this.i - 1))
        }
        return
      } else if (c === '$' && src[this.i + 1] === '{') {
        plain = false
        if (this.templateDepth >= MAX_TEMPLATE_DEPTH) {
          // Why: bound recursion so pathological input can never overflow the stack.
          this.i = src.length
          return
        }
        this.i += 2
        this.tokens.push('${')
        this.templateDepth++
        this.scan(true)
        this.templateDepth--
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
    const hex = /^0[xX]/.test(src.slice(this.i, this.i + 2))
    while (this.i < src.length) {
      const c = src[this.i]
      const signedExp =
        (c === '+' || c === '-') && !hex && /[eE]/.test(src[this.i - 1] ?? '') && this.i > 0
      if (!IDENT_PART.test(c) && c !== '.' && !signedExp) {
        break
      }
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
