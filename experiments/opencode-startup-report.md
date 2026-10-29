# Upstream report: concurrent cold startup creates the same SQLite schema twice

The maintainer added these observations to the existing upstream
[issue 53879](https://github.com/anomalyco/opencode/issues/53879#issuecomment-6503527526).
The detailed evidence is retained here; the reproducer link is pinned to
the reviewed merge commit.

## Title

2.2.1: concurrent first starts fail with `table account_state already exists`

## Environment

- OpenCode `@opencode/cli` 2.2.1, native Linux x64 executable.
- Linux x64, Node 24.19.0 driving the independent reproducer.
- A new isolated HOME and XDG config/data/cache/state directory per batch.
- No account, session, prompt or model request is needed.
- The same failure appeared while ACP was starting its native standalone
  server. The reproduction calls that native server directly, without OAR.

## Reproduction

[Standalone reproducer](https://github.com/botiverse/oar/blob/91568b9b91807569a3644c792f8ff685331e50cf/experiments/opencode-startup.ts)
uses only Node built-ins. Save it locally, install `tsx` if needed, then:

```sh
node --import tsx opencode-startup.ts /absolute/path/to/opencode ./startup-observations
```

It starts the executable with `serve --stdio --port 0`, the same child
entry used by native ACP. It waits for the readiness JSON, records early
exit/stderr, closes stdin and cleans up its owned POSIX process groups.
Each batch uses one shared, isolated HOME/XDG configuration. It compares:

1. Two sequential starts over a new database.
2. Four simultaneous starts over a different new database.
3. Four simultaneous starts over the database initialized by step 1.

No delay is inserted between the four concurrent launches. No request
retry or OAR import is used. The probe has a
20-second observation deadline; the observed failures occur in under half
a second, not at that deadline. It retains `report.json` and one stderr
file per child. Raw files should be reviewed before attaching them.

## Actual result

Two independent 2.2.1 batches reproduced the issue:

| Batch | Sequential starts | Concurrent cold starts | Concurrent warm starts |
| --- | --- | --- | --- |
| First | 2/2 ready | 1/4 exits 1 after 426 ms; 3/4 ready | 4/4 ready |
| Final probe | 2/2 ready | 3/4 exit 1 after 353-360 ms; 1/4 ready | 4/4 ready |

All failed cold starts report the same SQLite error while executing
`CREATE TABLE account_state`:

```text
SQLiteError: table `account_state` already exists
```

The final probe added version/platform metadata and isolated its version
query; its native startup sequence is unchanged. The old 2.2.0 control
passed all ten starts once. That single control does not establish that
2.2.0 is immune, or prove when this race was introduced.

## Expected result and impact

Concurrent first starts that share the native data directory should each
reach readiness, or coordinate schema initialization safely across
processes. A host that opens several ACP sessions on a new installation
can otherwise lose some sessions before they initialize. Running the
first startup sequentially and waiting for readiness before opening the
others avoided the failure in these controls; this is a host workaround,
not evidence of an upstream fix.

## Source evidence

At v2.2.1 commit `3ebcf9a32c7b28f658cfee80775448929361727a`,
[`database.ts`](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/core/src/database/database.ts)
uses a module-local map of semaphores keyed by database filename.
[`migration.ts`](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/core/src/database/migration.ts)
reads `sqlite_master` to decide whether the database is empty before its
bootstrap transaction creates the schema. Separate native processes do not
share the module-local semaphore. Two processes can therefore both observe
an empty database before one creates the tables. This is the suspected
race supported by the source and the direct error; no claim is made that
it explains every other startup failure.

This report and its reproducer were prepared with AI assistance. The
observations come from the actual native processes, not simulated SQLite
errors or a modified OpenCode binary.
