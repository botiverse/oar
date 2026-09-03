# @botiverse/oar-cli

Command-line interface for `@botiverse/oar`. It installs the `oar` executable without adding CLI dependencies to applications that only use the library.

```bash
npx @botiverse/oar-cli list
oar installation codex
oar usage claude
oar run claude "What does this repo do?"
```

## Commands

- `oar list` — registered runtimes and their capabilities.
- `oar installation [runtime]` — probe local installation and version, no
  account or usage I/O.
- `oar usage [runtime]` — account usage for each available installation.
- `oar run <runtime> <prompt>` — run one turn in a fresh session and show
  its progress; the exit code is 0 only when the turn completed.

## `oar run` — the run-and-verify entrypoint

By default `run` prints readable progress: assistant text verbatim, and
everything else as a bracketed meta line —

```
[thinking] The user wants...
[Running command] cat package.json
[Ran command] (0.4s)
The repo is a pnpm workspace...
[turn completed]
```

Flags:

- `--model <model>` — runtime-native model identifier.
- `--json` — print the raw session events as JSON lines instead of
  progress, plus a final `{"outcome": ...}` line.
- `--record <file>` — additionally write the run as an `oar-voyage/1` JSONL
  log (works in both output modes; the log always carries the raw events).

A run without a record is an anecdote. When a run is meant to be evidence —
verifying a doc claim, reproducing a bug, checking a runtime's live
behavior — pass `--record` so the claim points at a log anyone can read:

1. **Run live, don't infer.** A claim about runtime behavior is verified by
   actually running it, not by reading code or remembering last time.
2. **Record the evidence.** Keep the voyage log and reference it in the
   conclusion, so "it works" is checkable later.
3. **Triage what you see.** If reality differs from the docs, decide which
   moved: the runtime changed → fix the doc; oar regressed → file the bug
   and pin it with a test (`docs/development.md` has the test ladder).
4. **Report honest outcomes.** A turn that failed or aborted is a finding,
   not something to retry until it looks clean — the exit code and the
   `turn_ended` outcome in the log say what actually happened.

## The `oar-voyage/1` format

`--record` writes one JSON object per line, discriminated by `kind`. The
format is defined and owned by `@botiverse/oar`, which exports the line
builders and `openVoyage` recorder; other tools (such as the coxswain
cockpit) may write or read the same format as consumers.

- Line 1 is always the header:
  `{"kind":"header","format":"oar-voyage/1","runtime","model?","cwd","sessionId","startedAt","recorder"}`
  (`model` is omitted when none was requested; `recorder` names the writer,
  e.g. `oar-cli/0.0.5`).
- `{"kind":"submission","at","via","text"}` — one per human input; `via` is
  `"prompt"`, `"steer"`, or `"queue"` (the CLI only writes `"prompt"`).
- `{"kind":"event","event":{...}}` — one raw `SessionEvent` verbatim, no
  filtering or re-timestamping.
- `{"kind":"end","at","reason"}` — always the last line; a log without it
  is a truncated capture.

All timestamps are Unix epoch milliseconds on the same clock as each
event's `receivedAt`. Lines are written synchronously in arrival order, so
a crashed run still leaves a readable prefix.
