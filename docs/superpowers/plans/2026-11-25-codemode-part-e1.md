# Code Mode Part E1 (Learn foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the Learn switch is on, every `run_js` run (code, shape fingerprint, every inner call with input and output) is recorded locally; Orca finds scripts and direct MCP call chains repeated across chats, nudges the agent to offer `lib.save`, and lists the repeats in Settings › Code mode › Learn.

**Architecture:** A SQLite store (`codemode-learn.sqlite` in the profile user-data dir) runs in its own worker thread, copying the bots DB worker pattern, so no SQL touches Electron main. `CodemodeSession` gains an `onCall` hook with full replies; the service sends each finished run to the worker, which fingerprints it, stores it, and answers how many other chats ran the same shape. Direct-call chains are read from the agent-session journal on demand. E2 (writer, replay tests, proposals) builds on this store.

**Tech Stack:** TypeScript, `node:sqlite` via `src/main/sqlite/sync-database.ts` in a worker thread (`WorkerThreadRequestQueue`), Vitest, React settings UI, runtime RPC `defineMethod`.

**Spec:** `docs/superpowers/specs/2026-11-24-codemode-design.md` §9 items 1–2 (recording, signals) and §12; the user's decisions of 2026-11-25 below override §9 where they differ.

## User decisions (binding, 2026-11-25)

- Full Learn is built as E1 (this plan) then E2 (writer, replay-only tests, proposal cards, Learn button, nightly job).
- Testing in E2 is replay-only; no OS sandbox anywhere.
- Call outputs are stored only while the Learn switch is on, kept 30 days, and Settings has a Clear button.

## Global Constraints

- Learn switch: `GlobalSettings.codemodeLearnEnabled?: boolean`; absent means off; readers compare `=== true`; read per run, never cached.
- Store file: `join(getProfileUserDataPath(), 'codemode-learn.sqlite')`, hardened with `hardenSqliteDatabaseFiles`.
- Retention: runs older than 30 days are deleted; at most 5,000 runs kept (oldest deleted first).
- Per inner call: input JSON capped at 16 KiB, output JSON capped at 64 KiB (`truncated: true` marked when cut). Run code capped at 64 KiB.
- Shape hash: SHA-256 hex of the token stream with literals replaced by `_`, comments and whitespace dropped; a string literal used as a bracket member key (`x['k']`) is kept, so `mcp['fake-crm']` and `mcp['other']` differ.
- `repeated_script`: same shape hash, ok runs with at least 2 inner calls, in 2 or more distinct sessions within 30 days, not dismissed.
- `repeated_chain`: the same ordered sequence of 3 or more direct MCP tool calls (not `run_js`) within one turn, in 2 or more distinct sessions within 30 days, not dismissed.
- No sync SQLite or sync fs on Electron main: only the worker entry and the store import `sync-database`; the main-blocking ratchets must pass with no new baseline rows.
- Recording or nudging never fails or delays a run by more than 2 s: worker errors and timeouts are logged once and ignored.
- Repo lint: max 300 lines per file; `pnpm check:changed` before each commit; no Co-Authored-By trailers.
- Tests never touch the real profile dir, `~/.orca`, `~/.claude`, `~/.codex`.

## Review Focus

1. Learn switch off: nothing is written, no worker is spawned, no nudge appears. → Task 3 test `switch off records nothing`.
2. A script that only calls a saved function (`lib.*`) or makes fewer than 2 calls never produces a nudge. → Task 3 test `no nudge for lib calls or trivial scripts`.
3. Clear removes every run and call row and the file shrinks after `VACUUM`; a run in flight while clearing is not resurrected. → Task 2 test `clear empties the store`.
4. A very large output (5 MB MCP result) is stored cut to 64 KiB, marked truncated, and the run is still recorded. → Task 2 test `caps inputs and outputs`.
5. Two scripts that differ only in literal values share a shape; scripts calling different servers by bracket key do not. → Task 1 tests.

---

### Task 1: Shape fingerprint

**Files:**

- Create: `src/main/codemode/learn/codemode-shape.ts`
- Test: `src/main/codemode/learn/codemode-shape.test.ts`

**Interfaces:**

- Produces: `codemodeShapeTokens(code: string): string[]` and `codemodeShapeHash(code: string): string` (SHA-256 hex of `tokens.join(' ')`).
- A small tokenizer written here (no new dependency): identifiers/keywords, numbers, punctuators, string literals, template literals (literal parts become `_`, `${…}` expressions tokenized recursively), regex literals (a `/` starts a regex when the previous significant token is absent, a punctuator other than `)` `]` `}`, or one of `return typeof instanceof in of new delete void throw case do else yield await`), line and block comments (dropped). Literal tokens become `_` except a string literal directly between `[` and `]` whose `[` follows an identifier, `)` or `]` (kept as its quoted text). Unterminated strings/comments end at end of input (never throw).

- [ ] **Step 1: Failing tests** — `same shape for different literals` (emails, numbers, template contents); `whitespace and comments do not matter`; `bracket member keys are kept` (`mcp['fake-crm'].x()` vs `mcp['crm'].x()` differ); `computed key that is not a string literal is a token` ; `regex vs divide` (`a / b / c` and `x.replace(/a\/b/g, '')` tokenize without swallowing code); `template with nested braces` (`` `a${ {k:1}.k }b` ``); `unterminated input does not throw`.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode/learn` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): shape fingerprint for run_js scripts`.

### Task 2: Learn store in a worker thread

**Files:**

- Create: `src/main/codemode/learn/store/codemode-learn-store.ts` (schema, ops; the only non-entry file importing `sync-database`)
- Create: `src/main/codemode/learn/store/codemode-learn-ops.ts` (op list, `CodemodeLearnRemote` type, `callLearnOp`, `inProcessLearnStore` for tests)
- Create: `src/main/codemode/learn/db-worker/codemode-learn-worker-protocol.ts`, `codemode-learn-worker-entry.ts`, `codemode-learn-worker-client.ts`
- Modify: worker registration in `config/main-blocking-worker-entries.json`, `config/build-plugins/worker-thread-entry-names.ts`, `config/build-plugins/main-build-entry-points.ts`, `config/electron-builder.config.cjs`, `config/knip.json` — exactly as `bots-db-worker-entry` is registered (desktop-only; no orcad registration).
- Test: `src/main/codemode/learn/store/codemode-learn-store.test.ts`, `src/main/codemode/learn/db-worker/codemode-learn-worker-client.test.ts`

**Interfaces:**

- Consumes: `codemodeShapeHash` (Task 1).
- Produces (shared types in `src/shared/codemode/codemode-learn-types.ts`):
  ```ts
  export type CodemodeLearnCall = {
    seq: number
    tool: string
    input: unknown
    ok: boolean
    output?: unknown
    error?: string
    ms: number
  }
  export type CodemodeLearnRun = {
    runId: string
    sessionId: string
    projectRoot: string
    startedAt: number
    ms: number
    ok: boolean
    code: string
    calls: CodemodeLearnCall[]
  }
  export type CodemodeRepeatedScript = {
    kind: 'script'
    shape: string
    sessions: number
    runs: number
    lastSeen: number
    sampleCode: string
    tools: string[]
    projectRoots: string[]
  }
  export type CodemodeRepeatedChain = {
    kind: 'chain'
    signature: string
    tools: string[]
    sessions: number
    occurrences: number
    lastSeen: number
  }
  ```
- Store ops (all async through the worker; same names in-process for tests):
  - `record(run: CodemodeLearnRun, now: number): { shape: string; otherSessions: number; dismissed: boolean }` — stores the run and its calls (caps per Global Constraints, `truncated` flag on a cut field), applies retention, returns how many OTHER sessions ran this shape ok with ≥2 calls in 30 days.
  - `repeatedScripts(now: number, limit: number): CodemodeRepeatedScript[]` — signal `repeated_script`, newest sample code, sorted by sessions desc then lastSeen desc.
  - `runsForShape(shape: string, limit: number): CodemodeLearnRun[]` — newest first (E2 uses it).
  - `saveChains(chains: CodemodeRepeatedChain[], computedAt: number)` / `chains(): { computedAt: number | null; chains: CodemodeRepeatedChain[] }` — cache for Task 4.
  - `dismiss(key: string)` (shape hash or chain signature), `dismissed(): string[]`.
  - `clear()` — deletes all rows (runs, calls, chains, dismissed) and `VACUUM`s.
  - `stats(): { runs: number; calls: number; bytes: number; oldest: number | null }`.
- Client: `CodemodeLearnWorkerClient` with `store(path): CodemodeLearnRemote`, `WorkerThreadRequestQueue` with `idleTeardownMs: 60_000`, per-call timeout 10 s, `close()`; spawned lazily on first call.
- [ ] **Step 1: Failing store tests** (in-process store on a temp file): `records a run with its calls`; `otherSessions counts distinct other sessions, ok runs with ≥2 calls, within 30 days`; `retention drops runs older than 30 days and keeps at most 5000`; `caps inputs and outputs` (5 MB output → ≤64 KiB stored, truncated true); `repeatedScripts needs 2 sessions and skips dismissed`; `clear empties the store` (row counts 0, file size drops); `runsForShape newest first`.
- [ ] **Step 2: Failing worker test**: spawn the real built worker the way the bots worker client test does (or the in-repo helper it uses); `record` then `repeatedScripts` round-trip; `close` tears the thread down.
- [ ] **Step 3: Run** `pnpm vitest run src/main/codemode/learn` — FAIL.
- [ ] **Step 4: Implement**; register the entry; check `pnpm check:changed` (main-blocking ratchets) and that `out/main/codemode-learn-worker-entry.js` is produced by the main build (`pnpm build:main` or the repo's equivalent).
- [ ] **Step 5: Run** — PASS. **Commit** `feat(codemode): Learn store in a worker thread`.

### Task 3: Record runs and nudge the agent

**Files:**

- Modify: `src/main/codemode/host/codemode-run-host.ts` (`onCall` option fired next to `emit` with the full `HostReply`; `onFinish` hook returning optional extra result text), `src/main/codemode/codemode-launch-session.ts`, `src/main/codemode/codemode-service.ts` (+ a new `src/main/codemode/learn/codemode-learn-recorder.ts` holding the per-run buffer and the worker call, to keep the service under 300 lines)
- Modify: settings key in `src/shared/codemode/codemode-settings.ts`, `src/main/runtime/construction/runtime-store-contract.ts`, gates in `src/main/runtime/agent-session/launch/structured-agent-setting-gates.ts`, `structured-agent-session-runtime-contract.ts`, `structured-agent-session-host-assembly.ts` (`learnEnabled: () => boolean` into `processCodemodeService`)
- Modify: `src/shared/codemode/codemode-run-wire.ts` (`CodemodeRunHeader.seenInChats?: number`), `src/main/codemode/runs/codemode-run-store.ts` (`annotate(sessionId, runId, patch)` publishing a `run` event)
- Test: `src/main/codemode/learn/codemode-learn-recorder.test.ts`, extend `codemode-run-store` tests

**Interfaces:**

- Consumes: Task 2 client/remote (inject a fake remote in tests).
- Recorder: `CodemodeLearnRecorder` with `begin(sessionId, projectRoot, runId, code)`, `call(runId, CodemodeLearnCall)`, `finish(runId, { ok, ms, startedAt }): Promise<{ note: string | null; seenInChats: number | null }>`. Skips recording when the switch is off. `finish` awaits the worker for at most 2 s.
- Nudge rule: run ok, ≥2 inner calls, no inner call whose tool starts with `lib.`, `otherSessions ≥ 1`, not dismissed → append to the `run_js` result text exactly: `\nNote: you have run this same script in <N> other chat(s). If the person may want it again, offer to save it as a function with lib.save.` and set `seenInChats = otherSessions + 1` on the run header.
- [ ] **Step 1: Failing tests**: `switch off records nothing` (fake remote never called); `records code and full replies` (5 MB reply passes through uncut to the remote; capping is the store's job); `nudge after a shape seen in another chat`; `no nudge for lib calls or trivial scripts`; `worker failure or slow worker never fails the run` (remote rejects / never resolves → result unchanged within ~2 s, use fake timers); `seenInChats annotates the run record`.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (whole folder); `pnpm tc:node`; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): record runs for Learn and nudge on repeats`.

### Task 4: Repeated direct-call chains from chat journals

**Files:**

- Create: `src/main/codemode/learn/codemode-learn-chains.ts` (pure: per-session tool-call lists → `CodemodeRepeatedChain[]`)
- Create: `src/main/codemode/learn/codemode-learn-journal-source.ts` (reads tool-call items for local sessions updated in the last 30 days via the agent-session record store and journal reads — `visitItems({ kinds: ['tool-call'] }, …)` or a new reader-pool op — on worker threads only)
- Test: `src/main/codemode/learn/codemode-learn-chains.test.ts`, `codemode-learn-journal-source.test.ts`

**Interfaces:**

- `directMcpCall(item: AgentJournalToolCallItem): { server: string; tool: string } | null` — Claude raw names `^mcp__(.+?)__(.+)$`, Codex `mcpIdentity`; `run_js` (match via `src/shared/codemode/codemode-run-match.ts`) and non-MCP tools → null.
- `findRepeatedChains(sessions: { sessionId: string; turns: { tools: string[]; at: number }[] }[], now: number): CodemodeRepeatedChain[]` — a chain is a maximal run of ≥3 consecutive direct MCP calls inside one turn (`turnScope`); signature `server.tool > server.tool > …`; counts distinct sessions; keeps ≥2; ignores turns older than 30 days.
- `refreshChains(deps): Promise<CodemodeRepeatedChain[]>` — reads journals, computes, `saveChains` to the store; callers reuse the cache when `computedAt` is under 10 minutes old.
- [ ] **Step 1: Failing tests**: chain extraction (Claude and Codex name forms, run_js excluded, chains broken by a non-MCP tool or a turn boundary, length <3 ignored, 2-session threshold, 30-day window); journal source against a temp journal DB built with the repo's journal test helpers (find the existing journal test fixture builder).
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode/learn` — FAIL.
- [ ] **Step 3: Implement**; reads must not run sync SQL on main (`pnpm check:changed`).
- [ ] **Step 4: Run** — PASS. **Commit** `feat(codemode): find repeated MCP call chains in chat history`.

### Task 5: RPC, Settings › Learn, run view badge

**Files:**

- Create: `src/shared/rpc-contract/codemode/codemode-learn-params.ts`, `src/main/runtime/rpc/methods/codemode/codemode-learn.ts` (register like `codemode-lib.ts`; regenerate the params catalog)
- Create: `src/renderer/src/components/settings/codemode/CodemodeLearnSection.tsx`, `CodemodeRepeatRow.tsx`, `codemode-learn-client.ts`; modify `CodemodeSettingsPage.tsx`, fixture, `codemode-settings-search.ts`
- Modify: `src/renderer/src/components/native-chat/tools/codemode/CodemodeRunView.tsx` (+ fixture): "Ran in N chats" next to Save as function when `run.seenInChats ≥ 2`
- Test: `src/main/runtime/rpc/methods/codemode/codemode-learn.test.ts`, renderer tests for the section and the save-request text

**Interfaces:**

- RPC (desktop-only, service-gated like `codemode.lib.*`, hidden from `orca.*` by the `codemode` area rule): `codemode.learn.status` → `{ enabled, stats }`; `codemode.learn.list` → `{ scripts: CodemodeRepeatedScript[]; chains: CodemodeRepeatedChain[]; chainsComputedAt: number | null }` (refreshes chains if the cache is older than 10 minutes); `codemode.learn.dismiss { key }`; `codemode.learn.clear`.
- UI section "Learn" under Functions: switch "Learn from code mode runs" with the sub-line "Keeps your scripts and their results on this computer for 30 days to find work you repeat."; stats line ("N runs recorded, X MB"); Clear button with inline confirm; list of repeated scripts (sample code collapsed, "N chats · M runs · last <relative>", tools used) and chains ("a.b → c.d → e.f", "N chats"); each row: "Copy save request" (copies the Task-7-of-Part-D `saveAsFunctionPrompt` text built from the sample code, or for a chain a request to write a function doing those calls in order) and Dismiss. Empty state with the switch off: "Turn on Learn to find scripts you repeat."; on with nothing yet: "Nothing repeated yet. Scripts and tool chains used in 2 or more chats show up here."
- [ ] **Step 1: Failing RPC and renderer tests.**
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**, fixture states (off, empty, list), screenshot with the component-fixtures tool if available.
- [ ] **Step 4: Run** tests, `pnpm tc:node`, `pnpm tc:web`, `pnpm check:changed` — PASS.
- [ ] **Step 5: Commit** `feat(codemode): Settings › Learn lists repeated work`.

### Task 6: End-to-end proof

**Files:**

- Create: `src/main/codemode/learn/codemode-learn-end-to-end.test.ts`
- Modify: `tests/e2e/codemode/codemode-live.spec.ts` (live scenario 7a: Learn on, the same CRM task in two chats → the second `run_js` result contains the nudge and Settings › Learn lists the shape; skipped unless `ORCA_CODEMODE_LIVE=1`)

- [ ] **Step 1: Tests** (real QuickJS worker, real Learn worker thread, fake-crm, temp profile dir): `same task in two sessions nudges the second` (literals differ); `different servers do not match`; `switch off: no rows, no nudge`; `clear then run: counts restart`.
- [ ] **Step 2: Run** — PASS; run the live scenario with the token from `~/.orca-live-token` (`CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.orca-live-token)"`, never printed).
- [ ] **Step 3: Commit** `test(codemode): end-to-end proof for Learn recording`.

## Spec deviations (decided here)

- The store lives in the profile user-data dir (`codemode-learn.sqlite`), not `codemode-runs.db`, following the repo's convention for SQLite files and profile separation.
- The Learn switch defaults off (spec §12 lists the switch without a default); recording customer data needs an explicit opt-in.
- The agent nudge in the `run_js` result is new (not in §9); it is the E1 way to act on a repeat before E2's writer exists.
