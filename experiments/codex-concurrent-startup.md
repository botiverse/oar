# Codex concurrent first initialization

On 2026-10-02, native Codex 0.160.0 on Linux x64 failed to initialize a new
shared `CODEX_HOME` under concurrent startup. This occurs below the OAR
adapter. [Upstream report](https://github.com/openai/codex/issues/50290).

## Reproduce

```sh
node experiments/codex-concurrent-startup.ts /absolute/path/to/native/codex 8 3
```

The [script](codex-concurrent-startup.ts) needs Node.js 24 and only its standard
library. Pass the native executable, not the npm JS or Windows `.cmd` wrapper.
It creates temporary homes with a custom provider at a closed loopback port
and a dummy key. It sends `initialize` and then `initialized`, with no model
turn or login. Successful processes stay alive until every start in the
round settles; teardown waits for exit and stderr drainage.

Each child observation records its PID, home, start, initialization and exit
timestamps, exit status, signal and final 8 KiB of stderr. Individual rounds
and `report.json` are written under `oar-trial-run/codex-startup-*/`. The
15-second observation bound belongs to this experiment, not OAR's deadlines.

## Observed

Three rounds of eight processes per condition, repeated with the same totals:

| Startup condition | Initialized | SQLite initialization failures |
| --- | ---: | ---: |
| Concurrent, one fresh shared home | 3/24 | 21/24 |
| Concurrent, independent fresh homes | 24/24 | 0/24 |
| Concurrent after one initialization and full exit on the shared home | 24/24 | 0/24 |
| Shared fresh home, each initialization precedes the next spawn; earlier processes stay alive | 24/24 | 0/24 |

All 21 failures in each run exited with code 1 and no signal, before
initialization completed. They reported:

```text
Error: failed to initialize sqlite state runtime under <home>: failed to initialize state runtime at <home>
```

Retained runs: `2026-10-02T11-43-45.390Z` and
`2026-10-02T11-56-38.773Z`, under the output directory above. Runtime identity:
`codex-cli 0.160.0`, native `@openai/codex-linux-x64` binary, Linux x64;
driver Node.js 24.19.0.

## Scope and next evidence

The controls isolate a concurrent first-initialization failure, not the exact
SQLite operation or lock. They do not cover mature user homes, database
upgrades, independent host processes, Windows, or npm-wrapper teardown.

[OAR issue 57](https://github.com/botiverse/oar/issues/57#issuecomment-5951444951)
contains two Windows CI failures with the same native error. Both failed
vendor cases already used a separate home per test and neither calls account
usage, inventory or model listing alongside session startup. Their warmup
and session do reuse one home. The previous warmup ignored the `initialize`
response and resolved `codex` from PATH even when sessions used `OAR_CODEX_BIN`.
It therefore did not prove that the selected runtime had initialized the home.

Test setup now uses the selected binary, requires initialization to succeed,
and waits for that process to exit before returning the environment. The
old 2.5-second sleep is removed; it was not an initialization deadline.
Converting it into one caused premature termination during concurrent local
suite startup, even though isolated handshakes completed in 0.4–1.5 seconds.
The tests retain their existing overall deadlines and assertions.
Whether this resolves the Windows failures needs subsequent CI evidence; the
original jobs lack a native-process timeline proving or excluding overlap.
