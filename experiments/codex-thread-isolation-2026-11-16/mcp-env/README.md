# Codex per-thread MCP environment, 2026-11-16

Codex 0.169.0 accepts distinct `thread/start.config.mcp_servers.scope.env`
values for threads in one app-server. The two native stdio MCP children got
their own values, with separate process instances. This corrects the scope
of the earlier [`env_vars` observation](https://github.com/botiverse/oar/pull/828):
it did not test explicit MCP `env`.
This experiment changes no production adapter, credential policy or sharing
admission. It uses Linux x64, a local scripted model provider and synthetic
tokens only.

## What ran

[probe.ts](probe.ts) opens A and B with the same cwd, MCP command, arguments,
server name and `env_vars`. Only the explicit MCP token and shell token
differ. The app-server starts with a third token under the same MCP variable
name, an unlisted variable, and an explicitly forwarded control variable.
The MCP returns a constant acknowledgment; its environment is recorded in a
fixture journal outside `CODEX_HOME`, never in a tool result or prompt.

Each thread makes one MCP call and one shell call. Two fresh app-server
processes then resume the same threads: first without config, then with the
original config. This is 12 native turns and 24 captured provider requests.
The missing-MCP phase deliberately asks for the missing tool too; completion
of that turn alone is not evidence of a successful MCP call. The child
journal and provider payloads distinguish the outcome.

| Observation | Start | Fresh-process resume, config omitted | Fresh-process resume, config supplied |
| --- | --- | --- | --- |
| MCP child's token | Own A/B value | No MCP child or call | Own A/B value |
| Distinct MCP instances | Two | Zero | Two new instances |
| Explicitly allowlisted process variable in MCP | Present | No MCP child | Present |
| Unlisted process variable in MCP | Absent | No MCP child | Absent |
| Shell's per-thread token | Own A/B value | Absent | Own A/B value |
| Shell's inherited process controls | Present | Present | Present |

The two simultaneous MCP instances differ by native process and a UUID
generated in each child; counting uses UUIDs, not reusable PIDs. These
observations establish this explicit configuration path, not a guarantee
that all native tools, hooks or plugins use it. In particular, shell tools
still inherit process environment, and the earlier same-user process/file
reading observation is not invalidated.

## Persistence and provider visibility

Before prompts, while live after prompts, and after stopping each process,
the probe recursively reads **every regular file in its fresh `CODEX_HOME`**,
including SQLite databases and their WAL/SHM companions, native logs,
rollouts, shell snapshots and installed skills. It records byte counts,
SHA-256 fingerprints and literal-token hits, and records any read failure or
nonregular entry instead of silently ignoring it. The selected run had no
such omissions. Fixture journals and host RPC captures are outside the home.

- Neither thread's explicit MCP token nor its `shell_environment_policy.set`
  token appeared literally in any of the nine scans.
- App-server process controls appeared in live `shell_snapshots` files. They
  were absent in scans after those processes stopped. This is observed file
  lifecycle, not a secure-erasure guarantee.
- None of the 24 raw provider request payloads contained any test token.
  The separate socket experiment's three requests also contained none.
- Native RPC requests necessarily contain the explicit config tokens.
  Hosts must still treat their own request logging as credential-bearing.

Literal byte scanning does not detect encrypted, compressed or transformed
values, memory, keychains, or writes outside this fresh home. A scan is a
point-in-time observation, not proof that a short-lived file never existed.
Resume without config confirms non-retention on this tested path, not a
promise about other configuration sources or Codex versions.

## A model-invoked shell reading another thread

[socket-probe.ts](socket-probe.ts) starts an additional native app-server with
an explicit, unauthenticated `--listen ws://127.0.0.1:0` listener. It creates
two configured threads, gives B one synthetic conversation turn, then makes
A's scripted model invoke a shell program. That program opens a **new**
WebSocket connection, initializes it and calls:

- `thread/list`: succeeds and exposes B's preview.
- `thread/read` with `includeTurns: false`: succeeds and exposes B's metadata.
- `thread/read` with `includeTurns: true`: succeeds and exposes B's history.
- `config/read` with `includeLayers: true` and the cwd: succeeds, but reads
  directory configuration, not either thread's live config. The pinned
  `ConfigReadParams` has no `threadId` field.

None of these responses contained either thread's MCP or shell token. This
shows that this listener does not isolate conversation visibility by client;
it does **not** show that those methods reveal live thread credentials.
The shell saves responses out of band and returns a constant acknowledgment,
so seeing peer history does not itself copy it into the model request.

OAR currently uses stdio. This intentionally enabled WebSocket listener is
a separate transport observation, not an attack demonstrated against OAR's
stdio connection. No transport authentication, OS-user boundary, remote
host or production sharing setting was changed or evaluated.

## Source cross-check

The pinned source is [`d32063f96c2dff1dc96af839b3952abb6acfeda4`](https://github.com/openai/codex/tree/d32063f96c2dff1dc96af839b3952abb6acfeda4).
The three cited files were fetched separately at `75fc67e8`; fingerprints
are in [selected.json](selected.json).

| File | Relevant logic in 0.169.0 | Comparison with 75fc67e8 |
| --- | --- | --- |
| [`rmcp-client/src/utils.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/rmcp-client/src/utils.rs) | Constructs MCP env from native defaults, explicitly listed variables, CA variables and explicit overrides; filters non-inheritable names | Entire file identical |
| [`codex-mcp/src/server.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/codex-mcp/src/server.rs) | Connection identity contains transport config, including stdio env; equality compares that transport | Relevant identity comparison unchanged; later status-credential and server-key metadata additions are not in 0.169.0 |
| [`hooks/src/registry.rs`](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/hooks/src/registry.rs) | `Hooks::new` snapshots `std::env::vars_os()` and passes it to the hook runtime | Snapshot unchanged; later model-request hook return/callback changes are unrelated |

Native observations support the MCP connection/environment reading; hooks
were not rerun here. Current official [MCP configuration](https://developers.openai.com/codex/mcp)
and [app-server documentation](https://developers.openai.com/codex/app-server)
provide interface context; the pinned source and captured calls establish
this version's behavior.

## Reproduce and retained evidence

From the repository root, install dependencies and point `OAR_CODEX_BIN` at
Codex **0.169.0**. No real account is needed:

```sh
pnpm tsx experiments/codex-thread-isolation-2026-11-16/mcp-env/probe.ts /tmp/codex-mcp-env
pnpm tsx experiments/codex-thread-isolation-2026-11-16/mcp-env/socket-probe.ts /tmp/codex-mcp-socket
python3 experiments/codex-thread-isolation-2026-11-16/mcp-env/source-compare.py /tmp/codex-mcp-source
python3 experiments/codex-thread-isolation-2026-11-16/mcp-env/select.py /tmp/codex-mcp-env/evidence.json /tmp/codex-mcp-socket/evidence.json /tmp/codex-mcp-source/comparison.json
```

Run them sequentially because the shared fixture identifies newly launched
native processes. Both save failures as well as successful calls and clean
up their owned processes and homes. [select.py](select.py) validates the
observations and builds the committed selection from the two `evidence.json`
files and a three-file source comparison manifest. Full raw request/event
captures, complete per-scan file manifests, first successful runs and final
runs remain local; selected raw fingerprints allow matching them. All
published tokens are generated synthetic values.
