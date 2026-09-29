# Approvals

A host that runs agents for a person (rowrow steers many of them from a
phone) wants the risky actions to wait for that person, and the questions an
agent asks to reach them, possibly minutes later. oar runs every session
YOLO by default because in embedded use nobody sits at a prompt and a gate is
a hang. This page records the position oar takes when a host does have
someone to ask; the shapes are in [spec/approvals.md](../spec/approvals.md),
the per-runtime evidence on the [runtime pages](../runtimes/README.md).

**The position: the runtime's own permission gate, turned on and routed to
the host through the record stream. oar owns no approval policy.**

## The runtime's gate, not oar's

Every runtime that has a gate already decides what is risky: claude's rules
and read-only allowances, codex's trusted commands, kimi's permission modes.
An oar policy would be a second, weaker classifier beside the runtime's,
and it would disagree with what the runtime then actually runs. So
`approvals: "ask"` only switches the runtime's gate on and points it at the
host; which actions ask stays the runtime's, rules the user configured
included. The host decides who answers and when.

Switching it on has to be certain. A session that says it waits for a
person and then runs ungated is worse than one that never offered to wait.
Each adapter forces its gate (claude's permission mode, codex's policy and
reviewer, kimi's mode) and fails the open when the runtime reports another.
Where oar cannot force it or read it back, the runtime declares approvals
`not_enforceable` and refuses the open: grok's gate follows the user's
`permission_mode` config, which outranked the flag, the session switch and
the environment variable in a live run, and grok reports no mode in
effect. YOLO stays the default, so no existing host changes behavior.

## An answer is a control

Every action that expects an outcome is a request with a response
([record-stream.md](../spec/record-stream.md)); an answer is no exception.
It is two facts, recorded apart: the host's `answer` request carries the
decision in oar's words, and the runtime's request gets its `answered`
response carrying the reply exactly as sent. The first says what the person
decided, the second what the runtime received; a consumer that only wants
"is it settled?" reads the second, the one that already settled automatic
answers.

A refused answer leaves the request as it was and says why in one word.
The first answer stands, so two devices answering at once get one accept
and one `already_answered`; a stale screen gets `withdrawn` or
`runtime_exited`, never a silent no-op.

## What is asked rides on the request

oar reads what is asked (`ask`: the tool, its command, paths, diff, the
questions and their options) out of the runtime's own request, the way a
frame carries `events` beside `native`. The adapter reads it, because only
the adapter knows its protocol; the observe layer stays free of runtime
identity; the native body stays verbatim beside it.

The typed decisions are offered only where the runtime is shown to honor
them (`ask.choices`): codex takes `decline` and `acceptForSession` though its
own `availableDecisions` omits them; claude's "for the session" is its own
rule and directory suggestions kept to the session, never its mode switch;
an ACP `allow_always` option is session-scoped only where the runtime names
it so (kimi's "Approve for this session"). Everything else stays reachable
as a `native` reply, the runtime's own payload sent as given.

## A request never looks pending forever

A pending request ends only on the stream's word: its answer; the runtime
withdrawing it (claude cancels a pending `can_use_tool` when its turn is
interrupted; codex resolves a cleared request after the turn completes);
or the process exit, after which nothing can answer. ACP obliges the client
itself to answer a cancelled turn's requests `cancelled`, so the ACP adapter
does, and records it like any automatic answer.

A person owing an answer also explains a silence: while a request waits,
`status()` says whom the turn is `awaiting` beside the phase, and `stallOf`
reports no stall. Silence while waiting for input is not death
([liveness.md](liveness.md)).

## Decision gates

1. **Caller decision:** let a person approve, deny, or answer what the
   runtime asks, from any device, at any later time; hide the option where
   the runtime cannot guarantee it.
2. **Evidence it was unsafe:** every adapter disabled its gate or answered
   automatically; nothing let a host take a decision.
   [experiments/approval-channels.ts](../../experiments/approval-channels.ts)
   pins what each runtime asks and takes, token-free for claude and codex.
3. **Owning layer:** `SessionOptions.approvals`,
   `SessionCapabilities.approvals`, `Session.answer`, the `ask` on the toApp
   request body and the `app_request_withdrawn` event (contracts); the answer
   bookkeeping in the kernel; the readings and replies in each runtime.
4. **Cheapest regression tests:** kernel and fold unit tests
   (`tests/approvals.test.ts`), adapter tests against scripted processes,
   vendor tests on claude-aimock and codex-aimock.
5. **Every must/never has a case:** `sea-trial/cases/session-approvals.ts`
   on every backend.

## Refused

- **An oar approval policy** (allowlists, risk classes): a second
  classifier that disagrees with what the runtime runs. A host that wants
  one answers requests automatically.
- **Voiding a pending request at its turn's end**: not the runtime's word.
  codex resolves an interrupted turn's request just after `turn/completed`,
  and work outside a turn (a background sub-agent) can ask too.
- **Mapping every ACP `allow_always` to "for the session"**: ACP does not
  say its scope; some agents persist it.
- **Grok ask mode on its flags**: it ran ungated under a user config
  (evidence above). Reopened by a switch that outranks the config, or a
  report of the mode in effect.
