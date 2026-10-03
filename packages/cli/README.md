# @botiverse/oar-cli

Command-line interface for `@botiverse/oar`. It installs the `oar` executable without adding CLI dependencies to applications that only use the library.

```bash
npx @botiverse/oar-cli list
oar installation codex
oar usage claude
oar models claude
oar upgrade --check
oar login claude
oar run claude "What does this repo do?"
```

## Commands

The registered runtimes are OAR's `defaultRuntimes` plus cursor, which the
CLI adds itself on the `@cursor/sdk` 1.0.35 it depends on
(`src/runtimes.ts`). Commands that take an optional `[runtime]` cover every
registered runtime when it is omitted (or `all`).

- `oar list`: registered runtimes and their capabilities.
- `oar installation [runtime]` (alias `detect`): probe local installation
  and version, no account or usage I/O.
- `oar usage [runtime]`: account usage for each available installation.
- `oar models [runtime]`: models each available installation can run right
  now (login state, plan, and configured providers included). The first
  column after the runtime is the `id` to pass to `oar run --model`; `--json`
  prints the `ListModelsResult` per runtime, `--timeout <ms>` bounds each
  query.
- `oar run <runtime> <prompt>`: run one turn in a fresh (or `--resume`d)
  session and show its progress; [below](#oar-run-the-run-and-verify-entrypoint).
- `oar upgrade [runtime]`: upgrade each available installation with the
  runtime's own updater, one at a time; `--check` only reports the version
  the updater would install, `--json` prints the reports, `--timeout <ms>`
  bounds each runtime. The exit code is 1 when an upgrade failed or left the
  version unchanged, or when a runtime could not be probed. See [runtime updates](https://github.com/botiverse/oar/blob/main/docs/spec/update.md).
- `oar login <runtime>`: sign a runtime in through its own login. It prints
  the sign-in URL or device code and reads a pasted code from stdin when the
  runtime asks for one; Ctrl-C cancels. `--status` only reports whether each
  runtime (or the named one) is signed in, `--json` prints events, prompts and
  the result as JSON, `--timeout <ms>` bounds the login. The exit code is 0
  when signed in, 130 when cancelled, 1 otherwise. See [runtime login](https://github.com/botiverse/oar/blob/main/docs/spec/login.md).
- `oar mcp`: serve subagents over MCP on stdio, so an agent (claude, codex,
  any MCP client) can delegate tasks to other runtimes: `run` waits for a
  subagent's turn, `spawn` / `send` / `wait` work in parallel, and
  `runtimes`, `list`, `interrupt` and `close` complete the tool set. Flags
  `--runtimes`, `--max-running`, `--max-depth`, `--cwd`, `--log-dir`.
  Subagents run with full permissions. A codex agent starts MCP servers with
  a reduced environment, so give its `oar` entry
  `env_vars = ["OAR_SUBAGENT_DEPTH"]` for the nesting limit to hold. See
  [subagents](https://github.com/botiverse/oar/blob/main/docs/spec/subagents.md).
- `oar skills|mcps|tools [runtime]`: native inventories, see
  [below](#native-inventories).

## `oar run`: the run-and-verify entrypoint

By default `run` prints one opening line naming the session (the id
`--resume` takes; `[resumed <id> …]` on a resumed run) and the model and
effort the runtime reported while opening, when it did (the `model()` /
`effort()` folds, never the flags echoed). Then it prints readable progress
from the session's `events()`: assistant text verbatim (coalesced into blocks
via `coalesceText`), and other facts as bracketed meta lines
(`[compacting: threshold]`, `[compacted]` or `[compaction failed] reason`,
`[retry 2/3] reason`, `[waiting for app: type]`, `[task shell started]`).
Turn starts, usage, model and effort reports, native user message echoes,
task updates, withdrawn inputs, tool progress deltas and oar's own answers
to app requests print nothing:

```
[session 01a0e982-… · model gpt-6-luna · effort low]
[thinking] The user wants...
[Running command] cat package.json
[Ran command] (0.4s)
The repo is a pnpm workspace...
[turn completed]
```

The exit code is 0 only when the turn completed. The first Ctrl-C interrupts
the turn and exits 130; a second one disposes the session at once. The
process ends at most a second after the session is disposed, even when a
runtime left a handle behind (`@cursor/sdk` 1.0.35 keeps a 24 hour timer
for each shell call it moves to the background; `src/exit.ts`).

Flags:

- `--model <model>`: runtime-native model identifier.
- `--effort <level>`: runtime-native reasoning-effort level, one of the
  model's levels in `oar models` (`SessionOptions.effort`). A runtime that
  would run another level, or has none, refuses the open, and `run` exits 1
  with the runtime's word (`claude applies effort medium … although bogus
  was requested`).
- `--resume <sessionId>`: resume the runtime-native session a previous run
  printed, with a fresh stream (`SessionOptions.resume`); pair it with a
  different `--model` / `--effort` to switch between turns.
- `--image <file...>`: send image files with the prompt (png, jpeg, gif,
  webp) as the runtime's own image input (`InputOptions.images`); a runtime
  without image input rejects the prompt.
- `--json`: print the session records (`RawEvent`s) as JSON lines instead
  of progress (frames with their verbatim `native` payload and oar's
  `events`, plus the request/response records of the run), and a final
  `{"outcome": ...}` line.
- `--record <file>`: also write the run as an `oar-voyage/3` JSONL log (in
  both output modes; the log always carries every record).

A run without a record is an anecdote. When a run is meant to be evidence
(verifying a doc claim, reproducing a bug, checking a runtime's live
behavior), pass `--record` so the claim points at a log anyone can read:

1. **Run live, don't infer.** A claim about runtime behavior is verified by
   running it, not by reading code or remembering last time.
2. **Record the evidence.** Keep the voyage log and cite it in the
   conclusion, so "it works" is checkable later.
3. **Triage what you see.** If reality differs from the docs, decide which
   moved: the runtime changed, so fix the doc; or oar regressed, so file the
   bug and pin it with a test (`docs/development.md` has the test layers).
4. **Report honest outcomes.** A turn that failed or aborted is a finding,
   not something to retry until it looks clean: the exit code and the
   runtime's own `turn_ended` event in the log say what happened.

## The `oar-voyage/3` format

`--record` writes one JSON object per line, discriminated by `kind`. The
format is defined and owned by `@botiverse/oar`, which exports the line
builders and the `openVoyage` recorder; other tools (such as the
[oar-coxswain](https://github.com/botiverse/oar-coxswain) cockpit) may write
or read it as consumers.

- Line 1 is always the header:
  `{"kind":"header","format":"oar-voyage/3","runtime","model?","effort?","cwd","sessionId","startedAt","recorder"}`
  (`model` and `effort` are omitted when none was requested; `recorder`
  names the writer, e.g. `oar-cli/<version>`).
- `{"kind":"record","record":{...}}`: one `RawEvent` verbatim, no
  filtering or re-timestamping. Human inputs are already in the stream as
  `request` records, so there is no separate submission line; the `seq` on
  each record is the order.
- `{"kind":"end","at","reason"}`: always the last line; a log without it
  is a truncated capture.

All timestamps are Unix epoch milliseconds on the same clock as each
record's `receivedAt`. Lines are written synchronously in arrival order, so
a crashed run still leaves a readable prefix.

## Native inventories

```sh
oar skills codex --cwd /path/to/project
oar mcps claude --cwd /path/to/project --timeout 15000
oar tools pi
```

Each command prints JSON. `--cwd` defaults to the current working directory;
`--timeout <ms>` bounds each runtime. These are independent discovery
queries: no existing agent is inspected and no model prompt is sent, though
native startup can load extensions and connect configured MCP servers. Check
`kind`, `view` and `partial` before displaying results: `mcp-only` excludes
built-in tools, unsupported queries are not empty lists, and a pending or
failed MCP connection can produce a partial catalog. See the
[inventory contract](https://github.com/botiverse/oar/blob/main/docs/spec/inventory.md).
