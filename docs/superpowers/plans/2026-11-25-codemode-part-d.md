# Code Mode Part D (`lib.*` saved functions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripts in `run_js` can call saved JavaScript functions as `lib.<name>(args)`, save new ones with a person-only card, and the person manages them in Settings › Code mode › Functions.

**Architecture:** Functions are plain files (`<worktree>/.orca/lib/<name>.js`, `~/.orca/lib/<name>.js`) read by a main-process `CodemodeLibStore`. The sandbox gets four new host tools (`lib.list`, `lib.describe`, `lib.load`, `lib.save`) and one new VM binding, `__evalLib`, that evaluates a loaded function's source inside the same QuickJS context, so every call a function makes goes through the same host, gate and call budget. Trust (SHA-256 per function) and usage live in `~/.orca/lib-trust.json` and `~/.orca/lib-usage.json`.

**Tech Stack:** TypeScript, QuickJS (`quickjs-emscripten-core`), Node `fs/promises` + `crypto`, Vitest, React (settings + chat row), runtime RPC `defineMethod`.

**Spec:** `docs/superpowers/specs/2026-11-24-codemode-design.md` §8 (plus §4.1 gate rows for `lib.save`/`lib.trust`, §5.1 description, §10 `lib` tests, §10.2 scenario 5).

## Global Constraints

- Repo lint: max 300 lines per file; no sync fs in main (main-blocking-helper ratchet); no `as` casts beyond the repo's `consistent-type-assertions` rule; run `pnpm check:changed` before each commit.
- Nesting limit 8; recursion fails with an error whose message starts `lib recursion`.
- `lib.save` and `lib.trust` are `ask-person-only` in `own`, `ask`, `accept-edits`, `auto`, `full-access`; `refuse` in a read-only session.
- Project scope wins over global on a name clash.
- Each save copies the previous version to `.history/<name>.<timestamp>.js` in the same scope directory.
- Trust file `~/.orca/lib-trust.json`, keyed by project path (realpath of the session root) or `~` for global; value is SHA-256 hex of the file's exact bytes.
- Tool description lists at most 60 `lib.*` signatures.
- Function names: `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`, not one of `list describe save then toString toJSON valueOf constructor`.
- Function file at most 256 KiB.
- `docs/**` is gitignored: commit plan/doc files with `git add -f`.
- Never touch the real `~/.orca`, `~/.claude`, `~/.codex` in tests: every store takes an injectable `homeDir`.

## Review Focus

1. A malformed function file in a cloned repo (syntax error, no header, `@name` ≠ file name, too big) must not break `lib.list`, the description, or other functions: it is skipped and reported as a problem. → Task 1 test `skips malformed files with a problem`.
2. `await Promise.all([lib.f(a), lib.f(b)])` on an untrusted function must show one trust card, not two. → Task 4 test `one trust card for concurrent loads`.
3. A function edited on disk after it was trusted asks again (state `changed`) on its next load, even within the same session. → Task 4 test `changed file asks again`.
4. Stop while a save or trust card is open writes nothing and records no trust. → Task 4 test `stop during save card writes nothing`.
5. A name or project root that would escape the lib directory (`../x`, `a/b`, a path that is not an Orca worktree) is refused before any file access. → Task 1 test `rejects unsafe names`, Task 6 test `refuses unknown project root`.

---

### Task 1: Function files and the store

**Files:**

- Create: `src/main/codemode/lib/codemode-lib-header.ts`
- Create: `src/main/codemode/lib/codemode-lib-store.ts`
- Create: `src/shared/codemode/codemode-lib-types.ts`
- Test: `src/main/codemode/lib/codemode-lib-header.test.ts`, `src/main/codemode/lib/codemode-lib-store.test.ts`

**Interfaces:**

- Produces (shared types):
  ```ts
  export type CodemodeLibScope = 'project' | 'global'
  export type CodemodeLibOrigin = 'user' | 'agent' | 'learn'
  export type CodemodeLibParam = { name: string; type?: string; description?: string }
  export type CodemodeLibMeta = { name: string; description: string; params: CodemodeLibParam[]; savedBy: CodemodeLibOrigin }
  export type CodemodeLibFunction = CodemodeLibMeta & { scope: CodemodeLibScope; file: string; source: string }
  export const CODEMODE_LIB_NAME: RegExp   // ^[A-Za-z_$][A-Za-z0-9_$]{0,63}$
  export const CODEMODE_LIB_RESERVED: ReadonlySet<string>
  export const CODEMODE_LIB_MAX_BYTES = 256 * 1024
  ```
- Produces (header): `parseLibHeader(source: string): { meta: Partial<CodemodeLibMeta>; body: string } ` reading the first `/** ... */` block's `@name`, `@description`, `@param {type} name [description]`, `@saved-by`; `renderLibFile(meta: CodemodeLibMeta, source: string): string` — replaces any leading doc block with a rebuilt one, keeps the body; `libSignature(meta): string` → `name({a, b})` or `name()`; `definesFunction(source: string, name: string): boolean` (regex `\b(async\s+)?function\s+<name>\s*\(`).
- Produces (store):

  ```ts
  export class CodemodeLibStore {
    constructor(opts: { projectRoot: string | null; homeDir?: string })
    list(): Promise<{ functions: CodemodeLibFunction[]; problems: string[] }> // project shadows global
    get(name: string): Promise<CodemodeLibFunction | null> // project first
    read(name: string, scope: CodemodeLibScope): Promise<CodemodeLibFunction | null>
    save(input: {
      name: string
      source: string
      scope: CodemodeLibScope
      description?: string
      savedBy: CodemodeLibOrigin
    }): Promise<CodemodeLibFunction>
    remove(name: string, scope: CodemodeLibScope): Promise<void> // current file goes to history first
    move(name: string, from: CodemodeLibScope): Promise<CodemodeLibFunction> // fails if target exists
    history(name: string, scope: CodemodeLibScope): Promise<{ version: string; savedAt: number }[]> // newest first
    readVersion(name: string, scope: CodemodeLibScope, version: string): Promise<string>
    dir(scope: CodemodeLibScope): string | null // null: no project root
    // Validation and the exact file text, without writing; the save card shows `text`. save() calls it too.
    prepare(input: {
      name: string
      source: string
      scope: CodemodeLibScope
      description?: string
      savedBy: CodemodeLibOrigin
    }): Promise<{ text: string; meta: CodemodeLibMeta; exists: boolean }>
  }
  export function libTrustKey(scope: CodemodeLibScope, projectRoot: string | null): Promise<string> // '~' or realpath(projectRoot)
  ```

  Project dir `<root>/.orca/lib`, global dir `<homeDir>/.orca/lib`, history `<dir>/.history/<name>.<YYYYMMDDTHHmmssSSSZ>.js`. Writes go to a temp file in the same dir then `rename`. `version` strings are the history file's timestamp part and must match `^\d{8}T\d{9}Z$` before use.

- [ ] **Step 1: Write failing header tests** — `parses name, description, params and saved-by`; `renderLibFile replaces an existing header and keeps the body`; `libSignature renders params as an object pattern`; `definesFunction finds async and plain declarations only for that name`.
- [ ] **Step 2: Write failing store tests** (temp `homeDir` and temp project root):
  - `save writes the file with a rebuilt header and returns it` (assert file text starts with `/**`, contains `@saved-by agent`).
  - `save copies the old version to .history` (save twice → one history entry whose text is the first version).
  - `save requires a description` (no header, no `description` → throws `lib.save needs a description`).
  - `save requires the source to define the function` (throws `source must define function <name>`).
  - `rejects unsafe names` (`../x`, `a/b`, `save`, `1abc` → throw before any fs write; assert dir untouched).
  - `project shadows global` (same name in both → `list` has one entry with scope `project`; `get` returns project).
  - `skips malformed files with a problem` (a file with `@name other`, one over 256 KiB, one without header → absent from `list().functions`; three strings in `problems`, each naming the file).
  - `remove keeps the last version in history`; `move fails when the target scope has the name`; `history is newest first and readVersion rejects bad versions`.
- [ ] **Step 3: Run** `pnpm vitest run src/main/codemode/lib` — expect FAIL (modules missing).
- [ ] **Step 4: Implement** header, types, store as specified.
- [ ] **Step 5: Run** the same command — expect PASS; run `pnpm check:changed`.
- [ ] **Step 6: Commit** `feat(codemode): saved function files and store`.

### Task 2: Trust and usage records

**Files:**

- Create: `src/main/codemode/lib/codemode-lib-trust.ts`
- Create: `src/main/codemode/lib/codemode-lib-usage.ts`
- Test: `src/main/codemode/lib/codemode-lib-trust.test.ts`, `src/main/codemode/lib/codemode-lib-usage.test.ts`

**Interfaces:**

- Consumes: `libTrustKey` (Task 1).
- Produces:
  ```ts
  export type CodemodeLibTrustState = 'trusted' | 'unknown' | 'changed'
  export function libSourceHash(source: string): string // sha256 hex of utf8 bytes
  export class CodemodeLibTrust {
    constructor(opts?: { homeDir?: string })
    state(key: string, name: string, source: string): Promise<CodemodeLibTrustState>
    record(key: string, name: string, source: string): Promise<void>
    forget(key: string, name: string): Promise<void>
  }
  export class CodemodeLibUsage {
    constructor(opts?: { homeDir?: string })
    recordUse(key: string, name: string, at?: number): Promise<void>
    read(key: string, name: string): Promise<{ uses: number; lastUsedAt?: number }>
  }
  ```
  File shapes: `{ "version": 1, "trust": { [key]: { [name]: sha } } }` and `{ "version": 1, "usage": { [key]: { [name]: { uses, lastUsedAt } } } }`. Trust is written with `writeSecureJsonFile` (`src/shared/secure-storage/secure-file`). Writes in one process are serialized through a promise chain; an unreadable or malformed file reads as empty but is never overwritten by a read (only by `record`/`recordUse`, which first copy a malformed file to `<file>.bad`).
- [ ] **Step 1: Failing tests** — `unknown before record, trusted after`; `changed when the source differs from the recorded hash`; `keys are separate per project` ; `concurrent records both land` (two `record` calls in `Promise.all` → both names present); `malformed trust file reads empty and is kept as .bad on next write`; usage: `counts uses and keeps the last time`.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode/lib` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): trust and usage records for saved functions`.

### Task 3: `lib` inside the sandbox

**Files:**

- Modify: `src/main/codemode/sandbox/codemode-prelude.ts` (add `lib`)
- Modify: `src/main/codemode/sandbox/codemode-host-tools.ts` (add `lib.list`, `lib.describe`, `lib.load`, `lib.save`)
- Modify: `src/main/codemode/sandbox/codemode-script-runner.ts` (add `__evalLib` binding)
- Modify: `src/main/codemode/gate/codemode-gate.ts` (add `{ kind: 'lib-save' }`, `{ kind: 'lib-trust' }`)
- Test: `src/main/codemode/sandbox/codemode-lib-prelude.test.ts`, `src/main/codemode/gate/codemode-gate.test.ts` (extend)

**Interfaces:**

- Produces: host tool payloads the host (Task 4) must answer:
  - `lib.list` `{}` → `CodemodeLibMeta & { scope }` array
  - `lib.describe` `{ name }` → `CodemodeLibMeta & { scope, source }`
  - `lib.load` `{ name }` → `{ name: string; file: string; source: string }` (`file` is the display path, e.g. `lib/addCredits.js`)
  - `lib.save` `{ name, source, scope?, description? }` → `{ name, scope, path }`
- Produces: `export const CODEMODE_LIB_MAX_DEPTH = 8` in `codemode-prelude.ts`, interpolated into the prelude text.
- Prelude behavior: `globalThis.lib` is a Proxy; reserved keys `list`, `describe`, `save` map to host calls; `then`/`toJSON`/`valueOf`/`constructor` return undefined; `toString` returns `() => '[lib]'`; any other string key returns `async (args) => invoke(name, args, [])`. `invoke(name, args, stack)`: if `stack.includes(name)` throw `Error('lib recursion: ' + [...stack, name].join(' → '))`; if `stack.length >= CODEMODE_LIB_MAX_DEPTH` throw `Error('lib nesting limit 8 reached')`; `loaded = await call('lib.load', { name })`; `fn = evalLib('(function (lib) {' + loaded.source + '\n;return ' + name + '\n})', loaded.file)(childLib([...stack, name]))`; `return await fn(args ?? {})`. `childLib(stack)` is the same Proxy shape whose function keys call `invoke(key, args, stack)`. The wrapper adds nothing before the source on line 1, so error lines match the file.
- `__evalLib(code, file)` in the runner: `context.evalCode(code, file)` inside `enterVm`, returning the value or `{ error }`; the prelude deletes `globalThis.__evalLib` after capturing it, like `__host`.
- Gate: `lib-save` and `lib-trust` → `refuse` when mode is `read-only`, otherwise `ask-person-only` (including `full-access`).
- [ ] **Step 1: Failing tests** using `runScript` with a fake `ScriptHost` that serves `lib.load` from an in-memory map (follow the existing sandbox tests' harness):
  - `calls a saved function with args` (`lib.add({a:1,b:2})` → 3).
  - `a function can call mcp through the same host` (function body calls `mcp.crm.find_user({email})`; fake host records the `mcp.call`).
  - `nested functions work up to 8 deep` and `ninth level fails with nesting limit`.
  - `recursion fails` (`a` calls `lib.a` → error text contains `lib recursion: a → a`); indirect `a → b → a`.
  - `functions count toward the call budget` (limits `maxCalls: 3`, function makes 5 calls → `call limit 3 reached`).
  - `errors inside a function name the lib file` (throw on line 3 of the source → error text contains `lib/boom.js:3`).
  - `__evalLib is not reachable from agent code` (`typeof __evalLib === 'undefined'`).
  - `printing lib does not call the host` (`print(lib)`, `JSON.stringify({lib})`, `await lib` → zero host calls).
  - Gate table rows for `lib-save`/`lib-trust` × every mode.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode/sandbox src/main/codemode/gate` — FAIL.
- [ ] **Step 3: Implement.** If nested `evalCode` from inside a host function proves not re-entrant, fall back to capturing the VM's indirect `eval` in the prelude and keep the `lib/<name>.js` mapping by rewriting `<input>` frames in `codemode-script-error-text.ts`; note which path was taken in the commit body.
- [ ] **Step 4: Run** — PASS (whole `src/main/codemode` suite stays green); `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): lib.* in the sandbox`.

### Task 4: Host side — load, trust card, save card, description

**Files:**

- Create: `src/main/codemode/lib/codemode-lib-host-plan.ts`
- Modify: `src/main/codemode/host/codemode-host-dispatch.ts` (route `lib.*`; `hostCallLabel` shows `lib.<name>` for `lib.load`)
- Modify: `src/main/codemode/host/codemode-run-host.ts` (`CodemodeSessionOptions.lib?: CodemodeLibAccess`; per-run in-flight trust map; `libSignatures()`)
- Modify: `src/main/codemode/codemode-launch-session.ts`, `src/main/codemode/codemode-service.ts` (build `CodemodeLibAccess` for `input.root`; load signatures before `register`; pass `lib` into the description input)
- Modify: `src/main/codemode/server/codemode-tool-description.ts` (`lib?: string[]` signatures)
- Test: `src/main/codemode/lib/codemode-lib-host-plan.test.ts`, `src/main/codemode/server/codemode-tool-description.test.ts` (extend)

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export type CodemodeLibAccess = {
    store: CodemodeLibStore
    trust: CodemodeLibTrust
    usage: CodemodeLibUsage
    projectRoot: string | null
  }
  export function planLibHostCall(
    tool: 'lib.list' | 'lib.describe' | 'lib.load' | 'lib.save',
    fields: Fields,
    ctx: {
      lib?: CodemodeLibAccess
      check: (c: GateCheck) => Promise<string | null>
      signal: AbortSignal
      trustLoads: Map<string, Promise<HostReply>>
    }
  ): Promise<PlannedHostCall>
  ```
  `lib.list` / `lib.describe` → `READ_CHECK`. `lib.load`: read the function (project first); `state = trust.state(key, name, source)`; if not `trusted`, run the trust card through `ctx.check({ gate: { kind: 'lib-trust' }, allowKey: null, prompt: { title: 'Run saved function <name> (<scope>, <new | changed since you allowed it>)', detail: clip(source) } })`; on allow `trust.record`; on refusal the reply is `lib.<name>: <refusal text>`. Concurrent loads of the same `key/name/hash` in one run share one promise via `trustLoads`. A successful load calls `usage.recordUse` (errors ignored). `lib.save`: `store.prepare` validates first (errors return without a card), then `ctx.check({ gate: { kind: 'lib-save' }, allowKey: null, prompt: { title: 'Save function <name> to <project|global>' + (exists ? ' (replaces the current one)' : ''), detail: clip(file text) } })`; on allow `store.save({ ..., savedBy: 'agent' })` and `trust.record`; returns `{ name, scope, path }`. Default scope `project`; `project` with no project root fails `no project for this chat; save with scope 'global'`. Absent `ctx.lib` → every `lib.*` call fails `saved functions unavailable in this chat`.
  - The gate check for `lib.load` uses the existing `CodemodeApprovals.check`, so `DENIED_TEXT` becomes `lib.<name>: denied by user` via `deniedCallText`.
  - Description: new line `lib.<name>(args), lib.list(), lib.describe(name), lib.save({name, source, scope?, description?}) for saved functions.` and, when any exist, `Saved functions: <sig>, <sig>, …` with at most 60 signatures then `(+N more: lib.list())`.
- [ ] **Step 1: Failing tests** (real store/trust in temp dirs, fake `check`):
  - `load of a trusted function asks nothing`; `load of an unknown function shows the trust card and records on allow`; `deny leaves it untrusted and fails with lib.<name>: denied by user`.
  - `changed file asks again` (trust, then rewrite file, load → card again).
  - `one trust card for concurrent loads` (two loads in parallel → `check` called once, both succeed).
  - `read-only session refuses an untrusted load but runs a trusted one`.
  - `save shows the card with the file text and writes on allow`; `save validation errors never show a card`; `stop during save card writes nothing` (abort signal while `check` pending → no file, no trust record).
  - `load records usage`.
  - Description: `lists up to 60 signatures then a more note`; `no lib line when the chat has no lib access`.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode` — FAIL.
- [ ] **Step 3: Implement**, wiring `CodemodeLibAccess` in `createLaunchSession` (store with `projectRoot: input.root`, shared trust/usage instances owned by the service) and passing `lib: signatures` from `codemode-service.ts` (signatures read once per launch, after `readCodemodeServerSpecs`; a read failure logs and gives `[]`).
- [ ] **Step 4: Run** — PASS; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): run, trust and save saved functions`.

### Task 5: End-to-end proof in the real worker

**Files:**

- Create: `src/main/codemode/lib/codemode-lib-end-to-end.test.ts`

**Interfaces:**

- Consumes: `CodemodeSession` with the bundled worker and the `fake-crm` fixture exactly as `src/main/codemode/orca/codemode-orca-end-to-end.test.ts` sets them up; `CodemodeLibAccess` from Task 4.
- [ ] **Step 1: Write tests** (temp home + temp worktree with `.orca/mcp.json` pointing at `fake-crm`; approver records requests and answers `allow_once`):
  - `saved in one session, called in the next` — session 1 runs a script calling `lib.save({ name: 'addCreditsByEmail', description: 'Find a user by email and add credits.', source })` where the source uses `mcp['fake-crm'].find_user` + `add_credits`; one person-only card seen. Session 2 (new `CodemodeSession`, same root/home) runs `return await lib.addCreditsByEmail({ email: 'x@y.com', amount: 10 })`; no trust card (saved through Orca); `fake-crm` state shows +10.
  - `cloned function shows the trust card once` — write `.orca/lib/cloned.js` directly; first run → one `personOnly` card, second run → none.
  - `the gate applies inside functions` — mode `ask`, untrusted `fake-crm`: calling a trusted function that calls `add_credits` shows the `Call fake-crm.add_credits` card; deny → function throws `mcp.fake-crm.add_credits: denied by user`, state unchanged.
  - `recursion and nesting fail cleanly in the real worker`.
- [ ] **Step 2: Run** `pnpm vitest run src/main/codemode/lib/codemode-lib-end-to-end.test.ts` — expect PASS (fix earlier tasks' code if not; never weaken assertions).
- [ ] **Step 3: Commit** `test(codemode): end-to-end proof for lib.*`.

### Task 6: `codemode.lib.*` RPC and Settings › Functions

**Files:**

- Create: `src/shared/rpc-contract/codemode/codemode-lib-params.ts`
- Create: `src/main/runtime/rpc/methods/codemode/codemode-lib.ts` (+ register next to `codemode-connectors.ts`)
- Modify: Part C reviewed table / policy so the new `codemode.lib.*` methods are not exposed as `orca.*` (deny them the way `codemode.connectors.*` is denied); update the reviewed-table test.
- Create: `src/renderer/src/components/settings/codemode/CodemodeFunctionList.tsx`, `CodemodeFunctionRow.tsx`, `CodemodeFunctionSourceDialog.tsx`, `codemode-lib-client.ts`
- Modify: `CodemodeSettingsPage.tsx`, `CodemodeSettingsPage.fixture.tsx`, `codemode-settings-search.ts`
- Test: `src/main/runtime/rpc/methods/codemode/codemode-lib.test.ts`

**Interfaces:**

- Consumes: Tasks 1–2.
- Produces RPC (all take `projectRoot?: string`; a given `projectRoot` must equal the `path` of a worktree from `runtime.listManagedWorktrees(...)`, else `unknown project`):
  - `codemode.lib.list` → `CodemodeLibEntryView[]` = `CodemodeLibMeta & { scope; uses; lastUsedAt?; trusted: boolean; shadowed: boolean }` (shadowed: a global hidden by a project function), plus `problems: string[]`.
  - `codemode.lib.read` `{ name, scope, version? }` → `{ source }`.
  - `codemode.lib.history` `{ name, scope }` → `{ version, savedAt }[]`.
  - `codemode.lib.delete` `{ name, scope }` → `{}` (also `trust.forget`).
  - `codemode.lib.move` `{ name, from }` → entry; records trust under the new key (the person moved it).
  - Desktop-only and service-gated the same way `codemode.connectors.*` is.
- UI: a "Functions" block under Connectors. Project = the active worktree (`useActiveWorktree()`'s path); a header line says which. Each row: name, scope badge, `@saved-by`, uses, last used (relative), untrusted marker; actions View (dialog with highlighted source and a History list whose entries open that version), Move to global/project, Delete (inline confirm, no browser dialog). Empty state: "No saved functions yet. Agents save them with lib.save, or use “Save as function” on a finished script."
- [ ] **Step 1: Failing RPC tests** — `lists project and global with usage and trust`; `refuses unknown project root`; `delete keeps history and forgets trust`; `move refuses an existing target`; `read rejects a bad version`.
- [ ] **Step 2: Run** `pnpm vitest run src/main/runtime/rpc/methods/codemode src/main/codemode/orca` — FAIL.
- [ ] **Step 3: Implement RPC, policy entries, UI, fixture states** (empty, list with a shadowed global and an untrusted project function, source dialog with history).
- [ ] **Step 4: Run** tests — PASS; `pnpm typecheck` (or the repo's typecheck script) and `pnpm check:changed`; screenshot the fixture with the component-fixtures tool if available.
- [ ] **Step 5: Commit** `feat(codemode): Settings › Functions for saved functions`.

### Task 7: "Save as function" on a finished script, live scenario 5

**Files:**

- Modify: `src/renderer/src/components/native-chat/tools/codemode/CodemodeRunView.tsx` (button)
- Create: `src/renderer/src/components/native-chat/tools/codemode/codemode-save-as-function.ts` (prompt text + draft append)
- Modify: `CodemodeRunView.fixture.tsx` (finished state shows the button)
- Modify: `tests/e2e/codemode/codemode-live.spec.ts` (scenario 5)
- Test: `src/renderer/src/components/native-chat/tools/codemode/codemode-save-as-function.test.ts`

**Interfaces:**

- Produces: `saveAsFunctionPrompt(code: string): string` →
  ````
  Save the script below as a saved function with lib.save: pick a clear camelCase name and a one-line description, and turn its hard-coded values into parameters.

  ```js
  <code>
  ````
  ```
  and `askToSaveAsFunction(sessionId: string, code: string): void`, appending that text to the draft at `structuredAgentSessionDraftScopeKey(sessionId)` the way `appendQuoteToChatDraft` does (the person sends it).
  ```
- Button shows only when the run finished ok (`!failed`, not running), the code is not truncated, and `useNativeChatVisualOwner()` gives a `sessionId`.
- Live scenario 5 (skipped unless `ORCA_CODEMODE_LIVE=1`): session 1 prompt asks to save `addCreditsByEmail`; the test answers the person-only card Allow; session 2 asks to add 10 credits to x@y.com using saved functions; assert a `lib.addCreditsByEmail` inner call and `fake-crm` state.
- [ ] **Step 1: Failing test** — `prompt fences the code` and `appends to the chat's draft` (draft store test helper `setNativeChatComposerDraftStorageForTests`).
- [ ] **Step 2: Run** `pnpm vitest run src/renderer/src/components/native-chat/tools/codemode` — FAIL.
- [ ] **Step 3: Implement** helper, button, fixture, live scenario.
- [ ] **Step 4: Run** tests — PASS; `pnpm check:changed`.
- [ ] **Step 5: Commit** `feat(codemode): save a finished script as a function`.

## Spec deviations (decided here)

- The save card has no scope picker: the scope comes from the `lib.save` call (default `project`) and is shown in the card title; Settings › Functions moves a function between scopes. Approval cards in Orca are elicitation forms with fixed Allow/Deny options shared by every agent, and a per-card choice would need new UI in all of them.
- "Ignore" on the trust card is Deny: the call fails and the function stays untrusted, so the card returns next time.
- "Save as function" puts the request in the chat's composer instead of sending it, so the person can edit or add a name before it goes.
