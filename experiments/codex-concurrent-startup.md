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

The warm control stops immediately after the `initialize` reply and the
`initialized` notification: it closes stdin, sends SIGTERM, and waits for exit.
It does not wait for a background-setup notification or add a sleep. Across
the two runs, all 48 subsequent concurrent starts initialized. Reply to
warmup exit took 12 to 69 ms; exit to the next spawn took 1 to 3 ms. This directly
tests immediate termination after the handshake for this binary and platform;
it does not establish that every background task has finished, or invalidate
the older cold-runner failures recorded in commit `0f49bd2`.

## Model listing alongside startup

The same native script has a separate model-listing group:

```sh
node experiments/codex-concurrent-startup.ts /absolute/path/to/native/codex 8 3 models
```

Each round uses a fresh shared home. `models-only` runs eight `codex debug
models` commands; `models-with-server` starts one app-server and seven model
readers together. The report records each command, model count, exit and
stderr, plus the home's recursive directory listing after all children exit.
The custom provider and absence of login are the same as above.

On 0.160.0/Linux x64 (2026-10-02), all 24 standalone model readers and all
21 readers alongside three app-servers succeeded. Each reader exited 0 with
11 models, and all three app-servers initialized. All three models-only
homes still contained just the input `config.toml`; the mixed homes contained
the app-server's SQLite databases. Retained run:
`2026-10-02T12-53-47.036Z`, under the output directory above.

A separate models-only run under `strace -f -e trace=%file` also exited 0,
returned 11 models and left only `config.toml`. Its file-system calls included
no SQLite paths, so the conclusion does not rely only on absence of failure.
The 0.160.0 [CLI entry point][models-cli] builds a [model manager][models-build];
its [OpenAI-compatible implementation][models-manager] uses
`models_cache.json`, not the app-server's SQLite state runtime. Model cache
files may therefore appear with other provider or authentication settings.

Within this observed version and environment, model listing does not
initialize the state database. OAR leaves it outside the app-server
coordination. This does not establish the behavior of other versions,
platforms or provider/authentication combinations.

[models-cli]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cli/src/main.rs#L2068-L2095
[models-build]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/thread_manager.rs#L432-L446
[models-manager]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/models-manager/src/manager.rs#L304-L319

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
suite startup, even though isolated handshakes completed in 0.4 to 1.5 seconds.
The tests retain their existing overall deadlines and assertions.
Whether this resolves the Windows failures needs subsequent CI evidence; the
original jobs lack a native-process timeline proving or excluding overlap.
