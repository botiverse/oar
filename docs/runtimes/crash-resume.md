# What survives a crash and a resume

OAR resumes a conversation by its native id; it does not resume execution
([pi](pi.md#observation-history-and-children) states this for pi, and it holds
for every adapter). This page measures what that means when the whole process
tree dies in the middle of a tool call: which inputs and outputs the reopened
conversation still holds, what the model is told about the interrupted call,
and what the runtime does by itself when it is reopened. The questions follow
Pi Durable's recovery contract (an admitted input is not lost or doubled, a
partial answer is kept and marked, an interrupted tool reruns only when it is
safe, queued input stays queued), asked of runtimes whose loop OAR does not
own.

## The experiment

[`experiments/crash-resume.ts`](../../experiments/crash-resume.ts), run
2026-10-02 on linux x64. Phase one, in a child process: open a session,
prompt a turn that writes a sentence containing `ALPHA-TEXT` and then runs a
45 second shell command that would write `crash-marker.txt`, wait until the
tool call is running, then `steer` (asks for the word `PELICAN`) and `queue`
(asks for `OSPREY`). The orchestrator then SIGKILLs the child and every
descendant at once, as a container restart or an out of memory kill of the
whole tree would. Phase two, in a fresh process: reopen with `resume`, watch
for 20 seconds, then ask the model, with tools forbidden, to quote every user
message it has, its last text, and the result of its last shell command. The
native transcript is read afterwards.

| Runtime | Version | Model | Runs |
|---|---|---|---|
| claude | 2.1.284 | claude-opus-5-5 | 3: the shell command as given (claude ran it in the background, see below), a foreground python sleep, and the background case again with the prompt sent at once on reopen |
| codex | 0.158.0 | gpt-6-astra | 1 |
| pi | SDK 0.99.2, in process | gpt-6-sol | 2, the same result |

In every run the command's process died with the tree: `crash-marker.txt` was
never written, and no runtime ran the command again.

## Results

| After the kill and a resume | claude | codex | pi |
|---|---|---|---|
| Prompt admitted before the kill | Kept | Kept | Kept |
| Text written before the tool call | Kept | Kept | Kept (saved with the tool call when the message ended) |
| Interrupted tool call, as the model sees it | An error result written into the transcript on reopen: `[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]`, followed by a synthetic assistant message `No response requested.` | The call has no output in the rollout; the model is shown `aborted`, filled in when the history is rebuilt and never written | The call has no result in the session file; each request adds `No result provided` as an error result, never written |
| Background shell running at the kill | On reopen claude writes a task notification, `status: stopped`, `Background shell command didn't finish before the previous session ended`, and emits it as `task_notification` | Not exercised (codex ran the command as an exec session it polls; the poll was the interrupted call) | No background tasks |
| Steer accepted but not yet read by the model | Lost. The native file has a `queue-operation` enqueue marker without the text. A steer the model had already read at a step boundary (the first run) is ordinary transcript and survives | Lost: `turn/steer` was accepted and never reached the rollout | Lost |
| Queued input | Lost: the queue is adapter held (`capabilities.queue.durable: false`) | **Kept, and run by itself on reopen** as a new turn before any prompt (`capabilities.queue.durable: true`, confirmed) | Lost: adapter held (`durable: false`) |
| What the runtime does by itself on reopen | With a stopped background task: the notification and a `result` frame with `num_turns: 0` and `origin: {kind: "task-notification"}`, no model call. Without one: nothing | Runs the queued input as a turn | Nothing |
| A record of the interrupted turn in the native log | None until the reopen writes the entries above | None: the interrupted turn has no `task_complete` | None: the last assistant message ends with `stopReason: "toolUse"` |

## What a host can rely on

- **No runtime replays an interrupted tool.** All three treat it as unsafe
  to replay and tell the model so, each in its own words, and only claude
  keeps that statement in the transcript. Whether the effect happened is left
  to the model and the host; none of them checks.
- **A steer is only safe once it is echoed.** OAR records a steer's
  acceptance, and separately the runtime's `user_message` event
  ([conversation](../spec/conversation.md#native-observations)). In these
  runs that event appeared when the steer entered the conversation at a step
  boundary, not when it was accepted, and every accepted steer without it was
  gone after the crash. The host still holds the text in its own records and
  decides whether to send it again.
- **Queued input follows the declaration.** `queue.durable` is exactly what
  survives: codex keeps it and runs it at once on reopen, so a host must
  subscribe from the open (as the record stream already allows) and expect a
  turn it did not prompt; claude and pi drop it with the process.
- **Reopening is not always quiet.** codex may start a turn, and claude may
  close a stopped background task before the host says anything.

## Defect found: claude's reopen result can end the host's turn

The `result` frame claude emits on reopen for a stopped background task is
projected as `turn_ended`, like every `result`. When a host prompts right
after reopening, the prompt request precedes that frame (claude reports the
prompt `queued` in `command_lifecycle` and starts it only afterwards), so the
first `turn_ended` after the prompt is the notification's, not the prompt's:
`promptAndWait` returned `ended` with empty text in the third claude run, and
the real answer came after it. The frame is distinguishable: a turn claude
starts by itself carries `origin` (here `task-notification`, with
`num_turns: 0` when no model ran), and the host's prompt has a
`command_lifecycle` entry naming its `inputId`. The same race exists without a
crash whenever a background task ends as the host prompts. Tracked in
[issue #55](https://github.com/botiverse/oar/issues/55).

## Evidence

Voyage logs and `facts.json` per run under
`oar-trial-run/crash-resume-<runtime>-2026-10-02T07-*` (local, not checked
in); native files under `~/.claude/projects/`, `~/.codex/sessions/2026/10/02/`
and `~/.pi/agent/sessions/`. pi's synthetic result is
`transformMessages` in `@earendil-works/pi-ai` (`No result provided`,
`isError: true`).

Not covered: a runtime process that dies while the host lives (the existing
`kill-runtime` live contract case: an `exited` response pointing at no
request), subagents running at the kill, codex background terminals, and
claude's queue entries with content.
