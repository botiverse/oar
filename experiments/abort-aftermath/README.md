# The next request after an interrupted turn

Linux x64, 2026-11-20. The DSH run used the published OAR 0.125.0 package.
The other runs used [OAR 96dd70f0](https://github.com/botiverse/oar/tree/96dd70f0180e91a1b599430ee33a7cbfd675b07d).
Each comparison used the public session interface, a fresh session and a
scripted native model route. The [runtime matrix](../../docs/spec/runtime-matrix.md#what-the-next-model-request-contains-after-an-abort)
summarizes the differences. [Selected fields from each captured request](requests.json)
retain the control and terminal outcome alongside the evidence. Interruption
excerpts are substrings of the outgoing conversation. Static system prompts,
tool schemas, paths, credentials and generated identifiers are omitted.

## Controls

In each session the host submitted one initial prompt, called `session.abort()`
while that turn was active, waited for its root end, and used `session.prompt()`
to ask an unrelated question. No host steer or queued input intervened.
The follow-up request was identified by its unique user text. Auxiliary model
requests such as title generation were excluded. The source for each streaming
observation was the next request's conversation, including native tool results,
compared with the original request.

- **Stream open, no text.** The loopback server flushed response headers and
  withheld model text and the terminal event.
- **After one text chunk.** The provider sent the distinct assistant text
  `PARTIAL389` and withheld stream completion. The comparison looked for that
  text in the next generation request, independently of what OAR displayed.
- **During a tool.** A foreground shell command wrote a file before entering
  a bounded wait. The host waited for that file before interrupting. For Pi
  Durable a registered host tool did the same in its execute handler. A tool
  result's claim about whether the command ran can be checked against this
  independent observation.

The sessions used the repository's [Claude, Codex and Pi fixtures](../../sea-trial/harness/aimock.ts),
[ACP runtime fixtures](../../sea-trial/harness/aimock-acp.ts),
[Factory](../../sea-trial/harness/factory-aimock.ts), [Qwen](../../sea-trial/harness/qwen-aimock.ts),
[CodeBuddy](../../sea-trial/harness/codebuddy-aimock.ts) and [Pi Durable](../../sea-trial/harness/pi-durable.ts).
A loopback response gate before aimock forwarded the native protocol's first
text frame for the partial control and held the rest. The fixture's
[raw capture](../../sea-trial/harness/raw-capture.ts) retained the request
before any normalization for aimock. For CodeBuddy the plain prompt was
submitted one second after the aborted end. Its outgoing chat request
includes a native `skipRun` field on the interruption marker.

[Qoder 1.1.81](../../sea-trial/harness/qoder-native.ts) used its local native
response replay. Each session had one available generation. The first replay
withheld visible text using empty chunks, emitted a distinct text chunk, or
requested a real shell command, respectively. The next generation exhausted
the replay and preserved the request in the native session's `errorDetails`.
All three first turns ended aborted. The three follow-up generations failed
on the intentional exhaustion. No response from a remote Qoder model was
needed to inspect those inputs.

## DSH and Antigravity

On DSH 0.2.2-rc.5 the [loopback provider](../../sea-trial/vendor/support/dsh-provider.ts)
could hold an empty or partially written stream. Both yielded the native
`turn/end` reason `aborted/user`. With an empty stream, the two user inputs
followed one another. With partial text, DSH included the partial assistant
message between them. In neither case did the model receive a user-stop
marker. During a running bash command DSH returned `Error: tool call aborted`
to the model. In a separate immediate-delivery control, a plain prompt was
refused busy after abort acceptance and before the native end. The end
arrived 23 ms after acceptance. A subsequent prompt was accepted. An
eleven-second delayed control also admitted the new prompt after the aborted end.

Antigravity CLI 1.5.13 sent the partial assistant message, then the following
user-role message, then the new user question:

> Error: The stream was interrupted. Please continue the task you were working on.

That extra instruction occurred after a user-initiated cancel. The empty
stream control omitted it. The tool control carried a cancelled tool response.

## Interpretation

The provider answers were scripted. These measurements establish what
information a model receives about a user's stop. They do not predict which
task an independently generated answer would pursue. A turn's native terminal
status, a session transcript, and the model input are distinct observations.
