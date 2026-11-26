// The process's single Learn run: a second start while one goes is refused, and Clear stops it.
/** The process's one Learn run at a time. */
export class CodemodeLearnRunner {
  private current: AbortController | null = null

  running(): boolean {
    return this.current !== null
  }

  /** Starts `run` unless one is going (then null); it gets the signal `stop` aborts. */
  start<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> | null {
    if (this.current) {
      return null
    }
    const controller = new AbortController()
    this.current = controller
    const release = (): void => {
      if (this.current === controller) {
        this.current = null
      }
    }
    let started: Promise<T>
    try {
      started = run(controller.signal)
    } catch (error) {
      started = Promise.reject(error)
    }
    return started.finally(release)
  }

  /** Aborts the run going now, if any; it stays `running` until it has wound down. */
  stop(): void {
    this.current?.abort()
  }
}
