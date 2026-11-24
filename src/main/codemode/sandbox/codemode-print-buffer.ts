/** A script's printed lines, capped so a print loop cannot grow host memory past `limitBytes`. */
export class ScriptPrintBuffer {
  private readonly lines: string[] = []
  private bytes = 0
  private droppedBytes = 0

  constructor(private readonly limitBytes: number) {}

  add(line: string): void {
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    if (this.bytes + bytes > this.limitBytes) {
      this.droppedBytes += bytes
      return
    }
    this.bytes += bytes
    this.lines.push(line)
  }

  printed(): string[] {
    return this.droppedBytes > 0
      ? [...this.lines, `…[${this.droppedBytes} bytes of print output dropped]`]
      : [...this.lines]
  }
}
