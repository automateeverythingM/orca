import type { CodemodeLimits } from '../codemode-limits'
import type { HostCall, HostReply, ScriptResult } from './codemode-script-runner'

export type CodemodeWorkerInput = { code: string; limits: CodemodeLimits }

export type CodemodeWorkerMessage =
  | { type: 'call'; id: number; call: HostCall }
  | { type: 'reply'; id: number; reply: HostReply }
  | { type: 'done'; result: ScriptResult }
