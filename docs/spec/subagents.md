# Subagents

`@botiverse/oar/agents` lets a host start child sessions on any runtime,
follow them, and feed their results back into a parent. `oar mcp` serves the
same library to any agent that speaks MCP. The
[TypeScript contract](../../packages/oar/src/agents/types.ts) is normative.

## Model

Both vendors with native subagents converge on the same shape, and this
library follows it (evidence: claude 2.1.284 `Agent` / `SendMessage`, codex
0.158.0 `spawn_agent` / `followup_task` / `wait_agent`, probed 2026-10-01):

- **Spawn returns at once.** `spawn` opens a session, sends the task, and
  returns the subagent; the work continues in its own process.
- **Only the result reaches the parent.** Every turn the child's root agent
  ends becomes a `SubagentReport`: the turn's outcome, the root text said in
  that turn, the runtime-native `sessionId` (pass it as `resume` to continue
  later) and the log path. The transcript stays in the child's records.
- **A turn is a turn, whatever began it.** The task, a follow-up, a queued
  input and a turn the runtime starts by itself (claude does after a
  background task ends) each produce one report, numbered by `turn`.
- **Follow-ups.** `send(message, "followup")` starts a turn when the child
  is idle and steers its running turn otherwise (queueing when it cannot
  steer); `steer` and `queue` are the session controls of the same names.

## Reading results

Reports go to an unread list. `wait({ ids?, timeoutMs?, signal? })` takes
the unread reports, waiting up to `timeoutMs` (default 30 s) when there are
none; an empty answer means none ended in time. `next(id)` takes one
subagent's next report however long it takes; while it waits, waits that name
no ids leave that subagent's reports alone, so a caller collecting everything
cannot take a report someone else is waiting for. A `next` or `wait` stopped by
its signal takes nothing. `unread()` looks without taking.
`Subagent.nextReport()` observes the next report without taking it, and is
null when the subagent closes first.

Where reports go next is the application's decision, so the library gives
it a hook: `onReport(handler)` hands every report to the handlers instead of
the unread list (a `next(id)` still gets its own report first; a report every
handler throws on stays unread). The handler can post into the application's
own inbox, or wake a parent session the way claude's harness does for its
background tasks:

```ts
crew.onReport((report) => {
  void parent.deliver(formatReport(report), { origin: reportOrigin(report) });
});
```

`Session.deliver` prompts an idle parent, so it wakes with a turn of its own,
and steers or queues into a running one ([conversation](conversation.md#delivering-input-from-the-host)).
`formatReport` is one header line (id, runtime, turn, outcome, session) and
the report's text; `reportOrigin` marks the input as a notification from that
subagent.

## Tasks

The crew reports each subagent as a task, in the same shape runtimes report
their own background work (`task_started`, `task_updated`, `task_ended`; see
the [record stream](record-stream.md)): `onTask` delivers them live and
`tasks()` folds them. A host can therefore draw one panel for a runtime's
own background commands and subagents (`tasksOf` over a session's records)
and the subagents it started itself. Crew rows belong to the host, not to a
session, so their `sessionId` is empty; `childSessionId` names the
subagent's own session.

## Limits and policy

The library is mechanism; the host chooses the policy.

- **Depth.** A process's depth is `OAR_SUBAGENT_DEPTH` (0 when unset); its
  children run with depth + 1. `maxDepth` (default 1) refuses a spawn that
  would go deeper, with a reason telling the agent to do the task itself, so
  a child that runs `oar mcp` cannot fan out further by default. The guard
  needs the variable to reach that `oar mcp`: claude passes its environment
  to MCP servers, but codex starts them with an allowlisted one (`HOME`,
  `PATH` and a few more; checked on 0.158.0), so a codex child's `oar mcp`
  reads depth 0 unless its server entry lists
  `env_vars = ["OAR_SUBAGENT_DEPTH"]`.
- **Concurrency.** `maxRunning` (default 4) counts children whose turn is
  open; a spawn or follow-up past it is refused, with a reason that says to
  wait rather than retry.
- **Runtimes.** `runtimes` limits which runtimes children may use.
- **Permissions.** Children run with each adapter's defaults, which grant
  full access in their working directory (claude
  `--dangerously-skip-permissions`, codex `approvalPolicy: never` with
  `danger-full-access`, grok `--always-approve`). A parent that is itself
  restricted gains that access through a child, so whoever starts the host
  decides whether to offer subagents at all.
- **Evidence.** With `logDir`, each child's records, from its first, are
  written to `<logDir>/<name>-<sessionId>.jsonl` (the runtime id when the spawn has no name) as an `oar-voyage/3` log;
  characters other than letters, digits, `.`, `_` and `-` become `_`, so a
  chosen name never leaves the directory.

Refusals are typed (`unknown_runtime`, `not_installed`, `depth_limit`,
`running_limit`, `open_failed`, `rejected`, `closed`), never thrown. A turn
the runtime never ends still yields a report: failed with `runtime_exited`
when the process exits, aborted when `close` disposed it (claude's and
codex's adapters report no end for a disposed turn). `close` on the crew
also refuses new spawns, closes spawns still opening, and returns pending
waits.

## `oar mcp`

A stdio MCP server (newline-delimited JSON-RPC: `initialize`, `ping`,
`tools/list`, `tools/call`) over one crew. Flags: `--runtimes`,
`--max-running`, `--max-depth`, `--cwd`, `--log-dir`.

| Tool | Does |
| --- | --- |
| `runtimes` | Lists the offered runtimes and whether each is installed. |
| `run` | Spawns (or resumes, with `resume`) and waits for the first turn's report. |
| `spawn` | Spawns and returns at once. |
| `send` | Sends a follow-up, steer or queued message. |
| `wait` | Takes reports, waiting up to `timeoutMs` (at most 10 minutes). |
| `list`, `interrupt`, `close` | As named. |

An MCP server can only speak when called, so every other tool result names
the subagents with unread reports. A call the client cancels
(`notifications/cancelled`) gets no answer and takes nothing, so a cancelled
`run` leaves its report for `wait`. When the client goes away (stdin ends) or
the server is stopped, pending calls are cancelled and every subagent is
closed. MCP 2025-11-25 Tasks would let a client
poll a call natively, but neither claude 2.1.284 nor codex 0.158.0 uses them
as a client (probed 2026-10-01: both make a plain blocking call even for a
tool that requires tasks). claude does move a main-conversation MCP call that
runs past two minutes to the background and delivers its result as a task
notification, so a long `run` from claude becomes one of its background tasks.
