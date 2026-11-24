import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const sha256 = (token: string): Buffer => createHash('sha256').update(token).digest()

/** Per-session bearer tokens for the code-mode server; only their SHA-256 hashes are kept. */
export class CodemodeTokens {
  private readonly hashes = new Map<string, Buffer>()

  issue(sessionId: string): string {
    const token = randomBytes(32).toString('hex')
    this.hashes.set(sessionId, sha256(token))
    return token
  }

  resolve(token: string): string | null {
    if (!token) {
      return null
    }
    const hash = sha256(token)
    let found: string | null = null
    // Why: compare every entry so timing does not reveal which session matched.
    for (const [sessionId, stored] of this.hashes) {
      if (timingSafeEqual(hash, stored)) {
        found = sessionId
      }
    }
    return found
  }

  revoke(sessionId: string): void {
    this.hashes.delete(sessionId)
  }
}
