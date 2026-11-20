# harbor

A small Raft-like host for testing OAR the way it is used: real runtimes with
real logins, long-lived sessions that receive work as chat messages for hours,
and a QA agent outside that sends tasks and watches what happens. sea-trial
checks each contract in seconds with scripted providers; harbor finds what only
shows up after many turns, steers, restarts and compactions.

```bash
pnpm harbor up --agent claude --agent codex --agent agy=antigravity:hydrogen --detach
pnpm harbor send "@claude @codex triage the open issues labelled runtime and report back"
pnpm harbor watch            # findings as they happen
pnpm harbor status           # who is running, for how long, context, tokens, queue
pnpm harbor trace codex      # the latest turn: native frames with OAR's reading of each
pnpm harbor restart claude   # dispose and resume, as a host restart would
pnpm harbor down
```

Per-agent environment (`--agent-env name:KEY=VALUE`, repeatable) reaches that
agent's installation probe and sessions only: point two agents at two installs
of one runtime with `OAR_OPENCODE_BIN`, or give each its own `XDG_DATA_HOME`.
Cursor's in-process mode refuses a session environment, so leave it unset there.
`--for HOURS` stops the run at its deadline and `--max-disk-gb N` stops it when
the run directory grows past N GiB (checked every 5 minutes); both are
journaled as `limit`.

`harbor op <agent> <op> [arg]` runs one operation on the agent's current
session and journals what OAR returned (`kind: "op"`): `abort`, `steer TEXT`,
`compact`, `stop-task ID`, `usage` (usage, context and status) and
`breakdown`. Harbor checks the promise each one carries and records a finding
when it is broken, so a run judges OAR by its contracts rather than by what an
agent reports. Runs are on demand: exercise the paths a change touches, or the
ones production data says users hit.

Sessions are recycled the way Raft's constructed initial context does: a
session idle for more than `--recycle-idle-min` minutes (default 60) with more
than `--recycle-context` tokens in its context (default 128000) is not resumed
for the next message. Harbor opens a fresh one and puts a handoff in its first
delivery: the agent's latest channel messages, about 10K tokens, oldest first
(journaled as `recycle`; `--recycle-idle-min 0` turns it off). Without it a
long conversation makes every later model call re-read the whole history,
which on 11-19 used up a week of Antigravity's Gemini quota in 47 turns.
Recycling is judged before each delivery, so work held by a cap is checked
when it is finally sent, and a failed fresh open retries fresh with the same
handoff. `--day-tokens N` holds an agent's deliveries once its sessions
reported N tokens (input including cache, plus output, children included) in
a UTC day, counted whenever the runtime reports usage or the session closes,
and kept in state.json so a restart does not lift it; it is journaled as
`limit` with `day_tokens` until the next UTC day. A malformed value for any of
these flags stops `up` instead of turning the control off.

`--dir` (or `HARBOR_DIR`) selects the run directory, default
`~/.oar-harbor/default`, outside any repository so agents do not inherit a
checkout's instructions. `up` on an existing run reopens every agent with its
recorded session, so restarting the daemon is a resume test too.

## How an agent works here

Each agent is one OAR session for the whole run, in its own working directory
(`agents/<name>/work`, or `name=runtime:model` with `cwd` in state.json).
A message that names `@agent` (or `@all`) is delivered with `Session.deliver`:
a prompt when idle, steered or queued when busy, as a Raft Computer does.
A message from someone who is not an agent and names no one goes to every
agent. The first delivery of a new session explains the channel; agents answer
only by running their own `harbor` executable (`bin/<agent>/harbor`, named by
absolute path; harbor sets no session environment, which cursor refuses and
codex's login shell can reorder).

Agents run as the operating system user that started harbor, so they can reach
whatever that user is logged in to, as a host agent sharing a computer can. The
channel rules (answer only with `harbor send`; other chat tools on the machine,
such as `raft`, act as the host and are not theirs to run) go in the appended
system prompt on every open, as a Raft host's own instructions do, so
compaction cannot summarize them away. A runtime that refuses an appended
prompt (OpenCode 2, Kimi, Cursor, CodeBuddy) gets them in its first message and
again after a reported compaction, and every other message starts with a
one-line reminder, since not every runtime reports its compactions. An
OpenCode agent that had lost them found `raft` on PATH and used it to look for
its channel.

An input the session accepted is tracked until a turn consumes it. One the
stream hands back (`input_dropped`), or that a closed or crashed session never
consumed, is delivered again to the next session and journaled as
`redelivering`. What is waiting or unconsumed is kept in state.json, so the
same holds across `harbor down` and `up` or a crash of the daemon: the next
daemon delivers it first (`why: "harbor restarted"`). Open, close and restart run one at a time per agent, and only
the current session's root events count.

## What is recorded

| File | Contents |
| --- | --- |
| `channel.jsonl` | every message: seq, time, sender, text, recipients |
| `journal.jsonl` | opens and resumes, deliveries and how they landed, turn starts and ends with outcome and duration, retries, compactions, rejected controls, exits, findings |
| `agents/<name>/session-<n>.voyage.jsonl` | OAR's voyage log per session open: every native record verbatim with OAR's events |

## Findings

A finding is a journal entry with `kind: "finding"`. Each names the agent and
the voyage file, and the record `seq` where one exists, so
`harbor trace --voyage <voyage> --around <seq>` opens the evidence directly.
Turn numbers count per session, as `trace --session N --turn T` does.

| Check | Meaning |
| --- | --- |
| `turn_failed` | the runtime ended a turn as failed (its reason is kept) |
| `stalled` | a running turn produced no record for `--stall-min` minutes (default 10) |
| `declaration_mismatch` | an opened session's `steer`, `stopTask`, `images` or `compact` disagrees with what the installation declared before open |
| `context_usage_missing` | a completed root turn left `contextUsage()` without the `tokens` or `contextWindow` its declaration promises (a turn that compacted may leave `tokens` unknown, per `ContextUsageCapability`) |
| `usage_decreased` | the session's token total went down |
| `abort_without_turn_end` | `harbor op <agent> abort` was accepted but no root `turn_ended` followed within 30 s |
| `abort_rejected_while_running` | an abort was rejected while the session reported a running turn (review: may be a late race) |
| `unexpected_exit` | the runtime process exited while nobody was stopping it; harbor resumes the session after 5 s |
| `resume_loop` | the session exited within 30 s of opening twice in a row; harbor opens a fresh one |
| `resume_failed` | reopening the recorded session failed; harbor opens a fresh one |
| `open_failed`, `gave_up` | opening failed; harbor retries each minute, and stops after 5 failures in a row |
| `dispose_failed` | `dispose()` threw |
| `input_dropped` | the stream handed an accepted input back; harbor delivers it again |
| `delivery_rejected`, `delivery_dropped` | `deliver` was rejected; harbor retries with backoff and drops the messages after 5 rejections |
| `no_reply` | the agent went idle after a delivery that included a message from a person (not another agent) without posting anything; not reported after a failed turn, which `turn_failed` already covers |
| `leftover_processes` | processes still had the agent's working directory after dispose (agents sharing a `cwd` make this noisy) |

A finding is a lead, not a verdict: `no_reply` can be correct behaviour and
`turn_failed` can be the provider. The QA agent decides which layer owns it:
the runtime, OAR, or harbor.

## For the QA agent

Give agents real work with a checkable result: issues to triage, docs to verify
against code, small fixes on a branch. Mix in what hosts do to sessions:
messages while a turn runs, two agents talking to each other, `restart` mid-turn,
long enough runs to compact. Keep `harbor watch` open; for each finding, trace
it, decide the layer, and file it with the trace excerpt.
