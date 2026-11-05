# Codex native terminal cleanup: 2026-11-05

Codex 0.166.0 can terminate a **registered foreground command**, as well as a
command that has yielded to the model. Its native terminal APIs do **not**
reclaim a child that has created a new Linux session with `setsid`. A successful
`terminate` reply and an empty subsequent list therefore do not prove that the
turn's processes have ended.

This is the native probe requested in OAR task #168. No OAR product code or
public API changed. Cindy owns the subsequent design decision.

Follow-up: [PR #633](https://github.com/botiverse/oar/pull/633) added OAR's
opt-in process-table cleanup, with the scope and snapshot limits described in
the [Codex runtime page](../../docs/runtimes/codex.md#ending-a-turns-processes-on-abort).
That implementation does not change the native results below.

## Reproduce

Download [probe.py](probe.py), then run on Linux with Python 3 and the native
Codex 0.166.0 executable:

```sh
python3 probe.py --codex /path/to/codex --out /path/to/evidence
```

Use `--case scope-clean`, `--case active-foreground-terminate` or another label
from [selected.json](selected.json) to run one case. The probe uses a fresh home,
a loopback Responses provider and its own stdio MCP server. It does not read
the user's account configuration or use external inference. Each command starts
a child, writes its two PIDs to a private marker and waits. Cleanup checks the
process start identity before killing any remaining probe process.

Environment: Linux x64, native `codex-cli 0.166.0`, experiment base
`91c626a58e4564119f4bd03cd89211038fb9a7c2`. Source inspection used the
`rust-v0.166.0` tag, commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`.
The tag supplies the source explanation, not a claim that this probe rebuilt
the npm binary. Twelve native cases completed without probe errors; all owned
leftovers were reclaimed at the end.

## Results

The first eight cases wait for the native command-start notification before
interrupting. Foreground commands have a 30-second yield budget; yielded
commands use one second and a held follow-up model request. After the native
interrupted turn is reported, both parent and child remain alive in all eight.
The selected terminal control is then sent. Identity-checked observations are
taken at approximately 100 ms, one second and two seconds after dispatch.

| Command state | Child | Native operation | Parent after operation | Child after operation |
| --- | --- | --- | --- | --- |
| Foreground | Same process group | `terminate` | Gone | Gone |
| Foreground | Same process group | `clean` | Gone | Gone |
| Foreground | New session (`setsid`) | `terminate` | Gone | Alive |
| Foreground | New session (`setsid`) | `clean` | Gone | Alive |
| Yielded | Same process group | `terminate` | Gone | Gone |
| Yielded | Same process group | `clean` | Gone | Gone |
| Yielded | New session (`setsid`) | `terminate` | Gone | Alive |
| Yielded | New session (`setsid`) | `clean` | Gone | Alive |

All four `terminate` controls returned `terminated: true`; all four `clean`
controls returned `{}`. The target was absent from the native list afterward,
including in the four cases where its escaped child was still alive. Surviving
children retained the same PID/start identity and their separate session/group;
their parent had changed to PID 1.

Additional controls:

- **Active foreground command:** `terminate` before `turn/interrupt` also stops
  the registered command and its ordinary child. The API name does not restrict
  this case to commands that already yielded.
- **Scope of `clean`:** it stops the earlier background command in the same
  thread as well as the current command. It leaves the other thread's command,
  the pre-existing stdio MCP processes and the app-server alive. The current
  escaped child still survives.
- **Scope of `terminate`:** selecting the current logical process ID leaves the
  earlier same-thread command, other-thread command, MCP processes and app-server
  alive. It still leaves the current escaped child alive.
- **Launch window:** interrupt immediately after the process marker, before
  waiting for native command-start, finds an empty terminal list. Interrupt ends
  the parent but the escaped child survives. No `terminate` is sent because
  there is no listed target. This is a separate timing sample, not evidence that
  registered foreground commands are invisible. A preliminary run observed the
  same window; it is not included in the twelve-case matrix count.

## What the native API actually promises

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server#clean-background-terminals)
describes the experimental thread terminal APIs. The local native results and
the corresponding source establish these boundaries:

- `list` returns a logical `processId` and `itemId`; in these samples `osPid`,
  `cpuPercent` and `rssKb` are null. It is not an operating-system descendant
  census and has no current-turn filter.
- [`thread_processor.rs`](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server/src/request_processors/thread_processor.rs#L2592)
  submits cleanup and acknowledges it. The `{}` reply alone is not descendant
  exit evidence.
- [`process_manager.rs`](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/unified_exec/process_manager.rs#L538)
  starts a process before registering its retained entry. This explains why a
  process marker can precede visibility in `list`.
- The manager's
  [cleanup/list/terminate implementation](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/unified_exec/process_manager.rs#L1802)
  acts on retained entries. On Unix,
  [`process_group.rs`](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/utils/pty/src/process_group.rs#L269)
  signals a process group. A child that created another session is outside it.

## Design handoff

Native `terminate` can be part of a cleanup strategy, but it cannot alone fulfill
“end every process started by this turn” on Linux. Native `clean` additionally
has a wider scope than that promise, since it also ends old same-thread work.
Neither a successful reply nor an empty native list should be exposed as proof
that escaped descendants were reclaimed.

If a design needs to handle escaped descendants, attribution must be captured
while ancestry still exists. In the launch-window sample the parent is already
gone after interrupt, and the surviving child is no longer reachable through
that parent or the native terminal list. This is an implication of these
observations, not an implemented fallback or approval to widen cleanup scope.

Windows and macOS were not executed. The native Windows source includes Job
Object cleanup and a PID fallback; that source fact does not establish how
breakaway children behave on a real Windows host. Permission failures, failed
process-table reads, MCP-launched tools and child-thread commands also need
their own evidence before any cross-platform product guarantee.
