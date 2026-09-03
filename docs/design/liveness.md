# Liveness

"Whether an agent is alive or dead, and why" is a common problem for
multi-agent applications, and it belongs on the
[foundation list](foundations.md): naive integrations collapse "alive or
dead" into one boolean when it is really three different questions.

## Three questions, not one

1. **Is the process alive?** OS-level, cheap to answer, and the least
   meaningful — a live process can be wedged. claude's silent retry on 401
   is the canonical case: the process looks perfectly alive while making no
   progress forever, and the "why" is invisible unless the integration
   surfaces it.
2. **Is the session progressing?** A fact-stream question: are events
   flowing, are tool calls settling. Answerable only if
   status = fold(events) actually holds — which is why fact/control
   separation matters here too.
3. **If dead or stuck — why?** The one applications get wrong, because the
   natural implementation is *inference from silence*: no events for N
   seconds → "probably dead". But silence is ambiguous between thinking,
   waiting for input, a stuck retry loop, and actual death. Timeout guessing
   is where multi-agent applications rot — and sub-agents multiply it,
   because now you need to know *which* agent in the tree died, which is
   unanswerable without attribution.

## Death is a recorded fact, not an inference

The design answer is to make death observable in the record stream itself:

- **Dispose is a request record.** Asking a session to end is itself an
  event.
- **Process exit produces a response record.** Death shows up in the stream,
  not only in the OS.
- **Dangling tool calls get post-mortem settlement.** When a process dies
  mid-tool-call, explicit settlement records close the open state instead of
  hanging consumers forever
  ([hard problem 8](hard-problems.md#the-session-and-event-model)).
- **Replay is final.** Combined with the cursor, an observer who reconnects
  and replays reaches the same alive/dead/why conclusion as one who watched
  live. (grok's leader mode stumbled toward this property; oar makes it a
  guarantee.)
- **Per-agent, not per-process.** Agent attribution in the stream makes the
  liveness answer addressable per agent in the tree, not just per OS
  process.

## The honest limit

oar cannot force a runtime to explain a hang. When the runtime is silent, we
report observables — process state, last event, cursor position — and
declare the rest unknown, rather than synthesizing a heartbeat. A fake
"healthy" is worse than an honest "no signal since seq N".
