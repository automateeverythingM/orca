---
name: orca-compression
description: Compress assistant responses in this Orca chat with Terra (terse) or Ultra (maximum caveman-style) compression modes. Accepts a mode argument (`terra`, `ultra`, or `off`) optionally followed by the user's request.
argument-hint: <terra|ultra|off> [request]
---

# Response compression in an Orca chat

Control how densely you write prose responses in this conversation.

## Mode selection

The first word of your arguments sets the active mode (`terra`, `ultra`, or `off`).

- If text follows the mode word, handle that request immediately using the selected mode.
- Keep the selected mode active for every later reply in this conversation until the user switches modes or passes `off`.
- If no request follows the mode word, acknowledge the mode in three words or fewer.

## Modes

### `terra` (Terse compression)

Cut fluff while keeping clear, scannable technical prose.

- Drop greetings, pleasantries, throat-clearing, hedging, and restating the user's prompt.
- Prefer short, direct sentences and tight bullet points over paragraphs.
- Keep standard grammar and full technical clarity so complex trade-offs remain effortless to scan.
- Omit obvious transitions and closing summaries ("Let me know if you need anything else").

### `ultra` (Extreme compression)

Maximize token compression with caveman-style telegraphic prose.

- Target 65–75% fewer prose tokens than normal output.
- Drop articles (`a`, `an`, `the`), filler verbs, hedges, and conversational glue.
- Use minimal telegraphic fragments: `Cause: null token on refresh. Fix: guard in auth.ts:42.`
- Use compact symbols (`->`, `!=`, `|`) where unambiguous.
- Never repeat context the user already gave.

### `off`

Return immediately to normal, uncompressed response style.

## Accuracy invariants (apply in all modes)

- Never abbreviate, alter, or corrupt code blocks, diffs, CLI commands, file paths, symbol/API names, numbers, or error messages.
- Never omit required safety warnings, failing checks, or blocking caveats.
- Keep edited source files, code comments, commit messages, and documentation in normal project style unless the user explicitly asks to compress them.
