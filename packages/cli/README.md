# @botiverse/oar-cli

Command-line interface for `@botiverse/oar`. It installs the `oar` executable without adding CLI dependencies to applications that only use the library.

```bash
npx @botiverse/oar-cli list
oar installation codex
oar usage claude
oar models claude
oar run claude "What does this repo do?"
```

## Commands

- `oar list`: registered runtimes and their capabilities.
- `oar installation [runtime]`: probe local installation and version, no
  account or usage I/O.
- `oar usage [runtime]`: account usage for each available installation.
- `oar models [runtime]`: models each available installation can run right
  now (login state, plan, and configured providers included); `--json` prints
  the `ListModelsResult` per runtime, `--timeout <ms>` bounds each query.
  The first column after the runtime is the `id` to pass to `oar run --model`.
- `oar run <runtime> <prompt>`: run one turn in a fresh session and show
  its progress; the exit code is 0 only when the turn completed.

## `oar run`: the run-and-verify entrypoint

By default `run` prints readable progress from the session's `events()`:
assistant text verbatim (coalesced into blocks via `coalesceText`), and
everything else as a bracketed meta line (`[compacting: threshold]`,
`[compacted]` or `[compaction failed] reason`, `[retry 2/3] reason`,
`[waiting for app: type]`; tool progress deltas and oar's own answers to
app requests print nothing):

```
[thinking] The user wants...
[Running command] cat package.json
[Ran command] (0.4s)
The repo is a pnpm workspace...
[turn completed]
```

Flags:

- `--model <model>`: runtime-native model identifier.
- `--json`: print the session records (`RawEvent`s) as JSON lines instead
  of progress (frames with their verbatim `native` payload and oar's
  `events`, plus the request/response records of the run), and a final
  `{"outcome": ...}` line.
- `--record <file>`: additionally write the run as an `oar-voyage/3` JSONL
  log (works in both output modes; the log always carries every record).

A run without a record is an anecdote. When a run is meant to be evidence
(verifying a doc claim, reproducing a bug, checking a runtime's live
behavior), pass `--record` so the claim points at a log anyone can read:

1. **Run live, don't infer.** A claim about runtime behavior is verified by
   actually running it, not by reading code or remembering last time.
2. **Record the evidence.** Keep the voyage log and reference it in the
   conclusion, so "it works" is checkable later.
3. **Triage what you see.** If reality differs from the docs, decide which
   moved: the runtime changed → fix the doc; oar regressed → file the bug
   and pin it with a test (`docs/development.md` has the test ladder).
4. **Report honest outcomes.** A turn that failed or aborted is a finding,
   not something to retry until it looks clean: the exit code and the
   runtime's own `turn_ended` event in the log say what actually happened.

## The `oar-voyage/3` format

`--record` writes one JSON object per line, discriminated by `kind`. The
format is defined and owned by `@botiverse/oar`, which exports the line
builders and `openVoyage` recorder; other tools (such as the
[oar-coxswain](https://github.com/botiverse/oar-coxswain) cockpit) may write
or read the same format as consumers.

- Line 1 is always the header:
  `{"kind":"header","format":"oar-voyage/3","runtime","model?","cwd","sessionId","startedAt","recorder"}`
  (`model` is omitted when none was requested; `recorder` names the writer,
  e.g. `oar-cli/0.2.0`).
- `{"kind":"record","record":{...}}`: one `RawEvent` verbatim, no
  filtering or re-timestamping. Human inputs are in the stream already as
  `request` records, so the format has no separate submission line; the
  `seq` on each record is the order.
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

Each command prints JSON. Omit the runtime to query all runtimes. The directory
defaults to the current working directory. These are independent discovery
queries; no existing agent is inspected. Check `kind`, `view` and `partial`
before displaying results: `mcp-only` excludes built-in tools, unsupported
queries are not empty lists, and a pending/failed MCP connection can produce a
partial catalog. Native startup can load extensions and connect configured MCP
servers; no model prompt is sent.
See the [inventory contract](../../docs/spec/inventory.md).
