// Electron-free: shared by the Learn DB worker and its client.

export type CodemodeLearnWorkerRequest = {
  id: number
  /** The store's file: one per profile. */
  path: string
  op: string
  args: unknown[]
}

export type CodemodeLearnWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }
