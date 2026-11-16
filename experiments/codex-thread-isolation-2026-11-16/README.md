# Codex thread environment and credential boundaries

Codex CLI 0.169.0 on Linux passes thread-specific `shell_environment_policy.set`
to model-invoked shell tools and their background children. It does not pass
those values to the tested stdio MCP server or user `PreToolUse` hook. Moving
OAR's process environment into thread configuration therefore changes behavior.
This evidence does not admit that change or enable production sharing.

Separate app-server processes also do not provide a credential boundary when
tools run unrestricted as the same OS user. In both placements, a tool read the
other thread's synthetic token from its background process's `/proc/PID/environ`.
Use an OS-enforced boundary for mutually untrusted tools; process placement alone
is insufficient in this configuration. No real credentials were used or read.

## Reproduce and inspect

From the repository root, with the exact native binary installed:

```sh
OAR_CODEX_BIN=/path/to/codex-0.169.0 pnpm tsx experiments/sharing/codex-thread-isolation.ts oar-trial-run/thread-isolation
python3 experiments/codex-thread-isolation-2026-11-16/select.py oar-trial-run/thread-isolation/evidence.json > oar-trial-run/thread-isolation/selected.json
```

The [probe](../sharing/codex-thread-isolation.ts) uses a local synthetic provider,
disposable homes and two distinct neutral markers plus two distinct token markers.
The generated [children](../sharing/codex-thread-isolation-child.ts) inspect only
fixture-owned process IDs and that fixture's `CODEX_HOME`. They record observations
outside that home, returning constant acknowledgments to the model. Prompts and
tool output do not contain the token values. Native requests/events and child
observations are retained in the raw file, whose size and SHA-256 are in the
committed [selected results](selected.json). The [selector](select.py) asserts
cohort completion, child counts, propagation and cross-read results before emitting
the cited fields.

Each cohort has two threads, six completed turns and fresh storage. The phases
are MCP, background tool, then cross-read tool, for each thread. Threads share a
`CODEX_HOME` within each cohort. The synthetic tool setup uses unrestricted native
execution; there is no separate OS user, container or sandbox in this observation.

## Results

| Observation | Shared process, thread set | Separate processes, thread set | Separate processes, process env |
|---|---|---|---|
| Shell tool gets its own neutral/token pair | Yes | Yes | Yes |
| Background child gets its own pair | Yes | Yes | Yes |
| Stdio MCP using `env_vars` gets its own pair | No, both absent | No, both absent | Yes |
| User `PreToolUse` hook gets its own pair | No, both absent | No, both absent | Yes |
| Tool can read peer background token | Yes, both directions | Yes, both directions | Yes, both directions |
| Tool can read app-server process token | No token there | No token there | Both process tokens readable |
| Tool can read peer rollout and state/log SQLite files | Yes | Yes | Yes |

The separate-process/thread-set control shows that missing MCP and hook values
follow the configuration path, not sharing by itself. The third cohort reproduces
process-environment inheritance without using real OAR accounts. MCP configuration
uses `env_vars`, with no explicit `env`; explicit per-server environment and
remote MCP authentication were not tested. Hooks are user hooks in the disposable
`CODEX_HOME`, with session-only hook trust bypass. Environment-owned hooks and
other hook events were not tested.

Literal byte scans before and after the turns found no token values in the sampled
rollout, SQLite or log files. This is a bounded observation, not a claim that Codex
never persists tokens: files were readable, scans did not decode compressed or
encoded content, and no later lifecycle was observed. In the process-environment
cohort a shell snapshot contained thread B's token, and thread A's tool could read
it. See `afterPrompts` and tool `fileReads` in the selected results. Snapshot
capture timing is native behavior; the evidence does not require both snapshots
to persist both tokens.

## Native implementation cross-check

At native commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`:

- `codex-rs/rmcp-client/src/utils.rs`, `create_env_for_mcp_server`, reads requested
  `env_vars` from `env::var_os` and adds explicit MCP environment entries. That
  explains why thread shell policy alone does not populate these stdio children.
- `codex-rs/hooks/src/engine/command_runner.rs` distinguishes environment-owned
  execution from the user-hook command path. The latter is the path measured here;
  the separate environment-executor implementation is not evidence for all hooks.

The official [app-server documentation](https://developers.openai.com/codex/app-server)
and [configuration reference](https://developers.openai.com/codex/config-reference)
provide interface context. The pinned native observations above determine this
report's conclusions.

## Limits and validation

Only Linux and Codex 0.169.0 were measured. Windows/macOS credential isolation,
sandboxed execution, OS-user separation and remote servers remain untested. This
is separate from the resource/admission observations for shared app-server
placement. Cindy owns any design-rule change, and Tenny's credential-boundary
review is still required. Production code and placement policy are unchanged.

Two preparatory samples are retained locally: the first hook collector omitted
environment fields; the second reused the neutral value as its token, making
snapshot attribution ambiguous. The committed sample records hook environment and
uses distinct token values. Neither preparatory sample establishes additional
credential claims. The final native probe completes 18 turns; repository type,
lint, unit and mock behavior checks validate the committed fixture changes.
