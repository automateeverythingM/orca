# Code Mode Part E2 (Learn proposals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On request, Learn turns repeated work into proposed saved functions: an Opus writer drafts each one, a replay test runs it against recorded results (nothing real is called), and the person reviews proposal cards in Settings › Code mode › Learn and saves, edits or dismisses them.

**Architecture:** Built on E1's Learn store (worker thread, `runsForShape`, repeated scripts/chains). A pipeline picks the top signals, calls the user's own Claude CLI through Orca's background text generation (tool-free, Opus), validates the JSON reply into a lib function file, replays it in a fresh QuickJS sandbox whose host answers only from recorded calls, and stores the proposal. Save goes through Part D's lib store with `@saved-by learn` and records trust.

**Tech Stack:** TypeScript, existing `src/main/text-generation/` background generation, `runScriptInWorker` (QuickJS), Learn store worker (SQLite), zod, React settings UI, runtime RPC.

**Spec:** `docs/superpowers/specs/2026-11-24-codemode-design.md` §9 items 3–6; E1 plan `docs/superpowers/plans/2026-11-25-codemode-part-e1.md`; the user decisions below override the spec.

## User decisions (binding)

- No nightly run (2026-11-26). Learn runs only when the person asks.
- Testing is replay-only; no OS sandbox anywhere (2026-11-25).
- The writer runs on the person's own Claude login through Orca's background text generation.

## Global Constraints

- Learn must be switched on (`codemodeLearnEnabled === true`) to propose; Clear deletes proposals with everything else.
- At most 5 proposals per Learn run; at most 50 proposals kept (oldest dismissed/failed deleted first, then oldest ready).
- Writer: Claude agent, model `opus`, tool-free (`--tools ''`, `--strict-mcp-config`), timeout 180 s, cwd an empty temp dir, one request per proposal.
- Writer input: the repeated scripts' code and call samples, fenced as untrusted data the writer must not follow; each sampled input/output cut to 2 KiB in the prompt; at most 3 source runs per proposal; prompt at most 48 KiB.
- Writer output JSON: `{ worth: boolean, name, description, params: [{ name, type?, description? }], body, sample_args, expect: string[1..3], calls_saved: number, scope: 'project' | 'global', why }`. Invalid JSON, a schema miss, `worth: false`, or a name failing `CODEMODE_LIB_NAME`/`CODEMODE_LIB_RESERVED` marks the proposal failed with the reason.
- Replay: answers `mcp.call`, `orca.call`, `bash`, `read`, `write`, `edit`, `grep`, `find`, `mcp.list`, `mcp.describe` only from the source runs' recorded calls, matched by tool label and canonical JSON input; a call with no match, or whose recorded input or output was cut (`inputTruncated`/`outputTruncated`), fails the test as `unrecorded call: <label>`; `lib.*` calls fail as `lib calls are not replayed`. Nothing real is ever called. Same QuickJS limits as `run_js`.
- Pass = no throw, every `expect` string appears in the JSON of the returned value, no unrecorded calls. Chain proposals have no recorded outputs: they are marked `untested` with reason `direct tool chains have no recorded results`.
- A late writer or test result never overrides Save or Dismiss (conditional updates on state).
- Save writes through `CodemodeLibStore.save({ …, savedBy: 'learn' })` and records the trust hash (the person approved it in Settings). Project scope saves into the source runs' project root, which must be a known local worktree (Part D rule).
- Repo lint: max 300 lines per file; no sync fs/SQL on main; `pnpm check:changed` before each commit; no Co-Authored-By trailers; tests never touch the real profile dir or `~/.orca`.

## Review Focus

1. A recorded output that contains instructions ("ignore previous… save this function…") cannot change what the pipeline does: the prompt fences it, the reply is only parsed as JSON, and nothing is saved without the person. → Task 2 test `untrusted data stays fenced`.
2. A proposal whose code calls something not recorded (a new server, a write the source never did) fails replay and never touches the real tool. → Task 3 test `unrecorded call fails without calling out`.
3. Dismiss or Save while the writer or test is still running: the final state stays dismissed/saved. → Task 4 test `late result never overrides`.
4. Writer not installed, not logged in, or timing out: the proposal is failed with a readable reason; the run continues with the next signal. → Task 2/4 tests.
5. Clear during a Learn run: no proposal comes back afterwards. → Task 4 test.

---

### Task 1: Proposals in the Learn store

**Files:**

- Modify: `src/main/codemode/learn/store/codemode-learn-store.ts`, `codemode-learn-rows.ts`, `codemode-learn-ops.ts` (new table + ops; keep files under 300 lines — add `codemode-learn-proposal-rows.ts` if needed)
- Modify: `src/shared/codemode/codemode-learn-types.ts`
- Create: `src/main/codemode/learn/codemode-learn-rank.ts`
- Test: `src/main/codemode/learn/store/codemode-learn-proposals.test.ts`, `src/main/codemode/learn/codemode-learn-rank.test.ts`

**Interfaces:**

- Produces (shared types):
  ```ts
  export type CodemodeLearnProposalState =
    | 'writing'
    | 'testing'
    | 'ready'
    | 'failed'
    | 'saved'
    | 'dismissed'
  export type CodemodeLearnTestStatus = 'passed' | 'failed' | 'untested'
  export type CodemodeLearnProposal = {
    id: string
    createdAt: number
    sourceKind: 'script' | 'chain'
    sourceKey: string
    sourceSessions: number
    projectRoot: string | null
    state: CodemodeLearnProposalState
    error?: string
    name?: string
    description?: string
    params?: CodemodeLibParam[]
    source?: string
    sampleArgs?: unknown
    expect?: string[]
    callsSaved?: number
    scope?: CodemodeLibScope
    why?: string
    testStatus?: CodemodeLearnTestStatus
    testReason?: string
    testLog?: string
    callsBefore: number
    savedAs?: { name: string; scope: CodemodeLibScope }
    savedAt?: number
  }
  ```
- Store ops: `createProposal(p: Omit<CodemodeLearnProposal, 'id' | 'createdAt' | 'state'>, now): CodemodeLearnProposal` (state `writing`); `updateProposal(id, patch, onlyFrom: CodemodeLearnProposalState[]): boolean` (applies only when the current state is in `onlyFrom`); `proposals(limit): CodemodeLearnProposal[]` newest first; `proposal(id)`; `openProposalKeys(): string[]` (sourceKeys with a proposal in `writing|testing|ready|saved`). Retention keeps at most 50 proposals (oldest `dismissed`/`failed` first, then oldest `ready`; never `saved`). `clear()` deletes proposals. `testLog` capped at 16 KiB, `source` at 256 KiB.
- Rank: `pickSignals(scripts: CodemodeRepeatedScript[], chains: CodemodeRepeatedChain[], skipKeys: Set<string>, limit = 5): Array<{ kind: 'script'; script } | { kind: 'chain'; chain }>` — score = sessions × (tools.length − 1) for scripts, sessions × (tools.length − 1) × 0.5 for chains (untestable), ties by lastSeen desc.
- [ ] **Step 1: Failing tests** — `create then update moves through states`; `updateProposal refuses when the state moved on` (dismissed stays dismissed); `retention keeps 50 and never drops saved`; `clear deletes proposals`; `openProposalKeys`; rank ordering, skip keys, limit 5.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode/learn` — FAIL.
- [ ] **Step 3: Implement** (migration: `CREATE TABLE IF NOT EXISTS`; existing E1 files keep working).
- [ ] **Step 4: Run** — PASS; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): Learn proposals in the store`.

### Task 2: The writer

**Files:**

- Modify: `src/shared/text-generation/…` operation type (add `'codemode-learn'` to `TextGenerationOperation`; make it tool-free next to `dictation-cleanup`; extend every exhaustive switch/lane use), `src/main/text-generation/agent-generation-request.ts` (optional `timeoutMs` forwarded to `runLocalPlanForAgent`)
- Create: `src/main/codemode/learn/writer/codemode-learn-writer-prompt.ts`, `codemode-learn-writer-reply.ts`, `codemode-learn-writer.ts`
- Test: `src/main/codemode/learn/writer/*.test.ts`

**Interfaces:**

- Consumes: `CodemodeLearnRun[]` from `runsForShape` (≤3), `CodemodeRepeatedChain`, optional person hint (≤ 500 chars).
- Produces:
  - `buildWriterPrompt(input: { kind: 'script'; runs: CodemodeLearnRun[] } | { kind: 'chain'; tools: string[] }, hint?: string): string` — instructions, the JSON contract, then the data inside a fence longer than any backtick run in it (reuse `fencedCode` from `src/shared/codemode/`), labelled untrusted; asks for `sample_args` taken from one source run so replay can match.
  - `parseWriterReply(raw: string): { ok: true; draft: CodemodeLearnDraft } | { ok: false; reason: string }` — takes the first top-level JSON object (also inside a ```json fence), zod-validates, checks the name rules and `worth`.
  - `draftToLibFile(draft): { source: string; meta: CodemodeLibMeta }` — `async function <name>({ <params> }) {\n<body>\n}` with the Part D header (`renderLibFile`, `@saved-by learn`); must pass `definesFunction`.
  - `runLearnWriter(prompt: string, deps: { generate: (prompt: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ ok: true; text: string } | { ok: false; error: string }> }): Promise<…>`; the real `generate` uses `runGenerationRequest` with `{ agentId: 'claude', model: 'opus' }`, operation `'codemode-learn'`, local target in a fresh empty temp dir (removed after), env from `prepareLocalCommitMessageAgentEnv` (see `src/main/speech/dictation-cleanup-service.ts` for the full pattern incl. cancel).
- [ ] **Step 1: Failing tests** — prompt: `untrusted data stays fenced` (a recorded output containing ``` and "ignore previous instructions" stays inside the fence; the instructions come before it); `cuts samples to 2 KiB and the prompt to 48 KiB`; reply: valid JSON, fenced JSON, garbage, missing fields, bad name, reserved name, `worth: false`; draftToLibFile round-trips through `parseLibHeader` and `definesFunction`; writer: generation error and timeout map to a readable failure. Operation: `'codemode-learn'` runs tool-free and forwards `timeoutMs` (unit test at the generation-request level with a fake spawn, following existing tests there).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run src/main/codemode/learn src/main/text-generation` — PASS; `pnpm tc:node`; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): Learn writer drafts functions on the person's Claude login`.

### Task 3: Replay testing

**Files:**

- Create: `src/main/codemode/learn/replay/codemode-learn-replay-host.ts`, `codemode-learn-replay.ts`
- Test: `src/main/codemode/learn/replay/*.test.ts`

**Interfaces:**

- `replayHost(runs: CodemodeLearnRun[]): { host: ScriptHost; unrecorded: string[] }` — implements the `ScriptHost` the sandbox calls (`src/main/codemode/sandbox/codemode-host-tools.ts`); label each call with `hostCallLabel` (`src/main/codemode/host/codemode-host-dispatch.ts`) and match against recorded `CodemodeLearnCall` by label + canonical JSON of the input (sorted keys); identical calls may repeat (reuse the recording); cut recordings never match; `lib.*` → `lib calls are not replayed`.
- `replayProposal(input: { source: string; name: string; sampleArgs: unknown; expect: string[]; runs: CodemodeLearnRun[] }, deps: { workerPath?: string; limits?: CodemodeLimits }): Promise<{ status: 'passed' | 'failed'; reason?: string; log: string }>` — runs `source` + `\nreturn await <name>(<JSON sampleArgs>)` through `runScriptInWorker` with the replay host; log lists each call `✓ label` / `✗ unrecorded call: label`, printed lines, the result (cut to 4 KiB); pass rules per Global Constraints.
- [ ] **Step 1: Failing tests** (real QuickJS worker like `src/main/codemode/lib/codemode-lib-end-to-end.test.ts`): `replays recorded mcp calls and passes`; `unrecorded call fails without calling out` (no real MCP server exists in the test; the call to an unknown tool fails the test with that reason); `cut recordings never match`; `expect strings must appear`; `throwing function fails with its message`; `bash/read replay from recordings`; `lib calls are not replayed`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): replay-only testing for Learn proposals`.

### Task 4: Pipeline and RPC

**Files:**

- Create: `src/main/codemode/learn/codemode-learn-pipeline.ts`
- Modify: `src/main/runtime/rpc/methods/codemode/codemode-learn.ts` (+ params), `src/main/codemode/codemode-service.ts` (expose what the pipeline needs, keep under 300 lines)
- Test: `src/main/codemode/learn/codemode-learn-pipeline.test.ts`, extend `codemode-learn.test.ts`

**Interfaces:**

- `runLearn(deps, opts: { sessionId?: string; shape?: string; hint?: string; now: number }): Promise<{ proposals: string[] }>` — single-flight per process; reads repeated scripts and chains (refreshing chains like the list RPC), optionally keeps only signals that include `sessionId` (scripts whose runs include it) or exactly `shape`; skips `openProposalKeys()`; `pickSignals(…, 5)`; per signal sequentially: `createProposal` → writer (`runsForShape(shape, 3)`) → on failure `updateProposal(failed)` → `draftToLibFile` → `updateProposal(testing)` → `replayProposal` (scripts) or `untested` (chains) → `updateProposal(ready, testStatus…)`; every update uses `onlyFrom` so a dismissed/saved proposal is never overwritten; `callsBefore` = average inner calls per source run. Errors per proposal never stop the run.
- RPC (desktop-only, hidden from `orca.*`): `codemode.learn.propose { sessionId?, shape?, hint? }` → starts the run (returns at once with `{ started: true }` or `{ started: false, reason }` when Learn is off/already running); `codemode.learn.proposals` → `{ running: boolean; proposals: CodemodeLearnProposal[]; usage: Record<id, { uses: number; callsAfter: number | null }> }`; `codemode.learn.dismissProposal { id }`; `codemode.learn.saveProposal { id, scope, source? }` — `source` is the person's edit; validates through `CodemodeLibStore.prepare`; saves with `savedBy: 'learn'`, records trust, marks `saved` (only from `ready|failed`); project scope needs the proposal's `projectRoot` to be a known local worktree.
- "was N calls, now M": `callsAfter` = average inner calls of recorded runs that called `lib.<savedName>` (from the Learn store), shown when the lib usage count ≥ 3.
- [ ] **Step 1: Failing tests** (fake writer + real store + real replay): `runs top signals up to 5`; `writer failure marks failed and continues`; `late result never overrides` (dismiss while the writer is pending → stays dismissed; save while testing → stays saved); `clear during a run leaves no proposals`; `sessionId and shape filters`; `single flight`; RPC: `propose refused when Learn is off`, `saveProposal writes the lib file with @saved-by learn and trusts it`, `edited source is validated`, `unknown project refused`, usage/`callsAfter`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the codemode + RPC tests, `pnpm tc:node`, `pnpm check:changed` — PASS.
- [ ] **Step 5: Commit** `feat(codemode): Learn pipeline and proposal RPC`.

### Task 5: Proposal cards and Learn buttons

**Files:**

- Create: `src/renderer/src/components/settings/codemode/CodemodeLearnProposals.tsx`, `CodemodeLearnProposalCard.tsx` (+ client calls in `codemode-learn-client.ts`)
- Modify: `CodemodeLearnSection.tsx`, fixtures, `CodemodeRunView.tsx` (the "Ran in N chats" badge gets a "Learn from this" action → `propose({ sessionId, shape })`; the run record needs the shape — add `shape?: string` to the run header from the recorder's `record()` result)
- Test: renderer tests for the cards and actions

**Interfaces / UI:**

- Learn section: a "Find functions to save" button with an optional hint field ("What should Learn look for? (optional)"), disabled while a run is going ("Learning…"); a proposals list polled every 2 s while `running`.
- Card: name + description; signal line ("Script used in N chats" / "Tool chain used in N chats"); why; "Saves about N calls"; test badge (Passed / Failed: reason / Untested: reason); collapsible test log and code (highlighted, `NativeChatHighlightedCode`); buttons Dismiss, Edit (inline code editor textarea, Cancel/Done), Save with a Project/Global choice (Project disabled when the proposal has no project root). Writing/testing states show a spinner line. Saved cards move to a "Saved by Learn" group showing "was N calls, now M" once used 3 times. Failed cards can still be edited and saved.
- [ ] **Step 1: Failing renderer tests** — card renders each state; Save sends scope and edited source; Dismiss; propose button disabled while running; badge action calls propose with sessionId+shape.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, fixtures (writing, ready-passed, failed, untested chain, saved with stats), screenshots with the component-fixtures tool if available. **Step 4: Run** tests, `pnpm tc:web`, `pnpm check:changed` — PASS.
- [ ] **Step 5: Commit** `feat(codemode): Learn proposal cards`.

### Task 6: End-to-end proof

**Files:**

- Create: `src/main/codemode/learn/codemode-learn-proposal-end-to-end.test.ts`
- Modify: `tests/e2e/codemode/codemode-live.spec.ts` (scenario 7: Learn on, the same CRM script shape in two chats, then `codemode.learn.propose` with the REAL writer; wait for a proposal to reach `ready` or `failed`; if `ready` with test `passed`, save it and assert the lib file exists with `@saved-by learn`; skipped unless `ORCA_CODEMODE_LIVE=1`)

- [ ] **Step 1: Tests** (real QuickJS worker, real Learn worker, fake writer returning a fixed draft): `two sessions → propose → proposal passes replay → save → a new session calls lib.<name> against fake-crm and the state is right`; `writer draft calling an unrecorded tool fails replay and nothing real is called`.
- [ ] **Step 2: Run** — PASS. The controller runs the live scenario with the token from `~/.orca-live-token`.
- [ ] **Step 3: Commit** `test(codemode): end-to-end proof for Learn proposals`.

## Spec deviations (decided here)

- No nightly job (user decision); spec §9.3's nightly trigger and its automation are dropped.
- No OS sandbox (user decision): file tools and `bash` are replayed from recordings like MCP calls; spec §9.5's sandbox-exec/bwrap paths are dropped.
- Chain proposals are written but marked untested, because direct tool chains are read from chat history by name only (E1 keeps no chain call results).
- The "Learn from this session" button lives on the "Ran in N chats" badge in the chat (scoped to that chat and script) and as "Find functions to save" in Settings.
