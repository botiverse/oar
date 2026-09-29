# Approvals and runtime questions

> Part of the [record-stream spec](README.md). Why the contract takes this
> shape: [design/approvals.md](../design/approvals.md). Per-runtime native
> evidence: the runtime pages under "Tools, permissions".

A session opened with `SessionOptions.approvals: "ask"` runs the runtime's
own permission gate and routes it to the host. Every approval or question
the runtime raises is a `toApp` request that holds its turn until
`Session.answer` settles it, however much later. `"never"` (the default)
keeps the YOLO behavior every host had before: no gate, nothing waits for a
person.

## Declaring it

```ts
interface SessionCapabilities {
  // …steer, queue, attribution
  readonly approvals:
    | { readonly kind: "supported" }
    | { readonly kind: "unsupported"; readonly code: "no_gate" | "not_enforceable"; readonly reason: string };
}
```

A property of the runtime, whichever mode the session runs in. Starting a
session with `approvals: "ask"` where it is `unsupported` rejects with an
Error carrying `reason`; where it is `supported`, the open never runs
ungated: the adapter forces the runtime's gate on and fails the open when
the runtime reports another policy.

| Runtime | `approvals` | The gate `"ask"` turns on |
|---|---|---|
| claude | supported | `--permission-mode default --permission-prompt-tool stdio` (no `--dangerously-skip-permissions`) |
| codex | supported | `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"` on `thread/start` / `thread/resume`; the reply must echo both |
| kimi | supported | session mode `default` ("Manual approvals"), set when the session opens in another |
| grok | unsupported, `not_enforceable` | none: a user's `permission_mode = "always-approve"` outranked every switch oar has, and grok reports no mode in effect |
| pi | unsupported, `no_gate` | pi has no permission gate |

## What is asked: `AppAsk`

The runtime's request is recorded verbatim (`RequestBody.native`), with
oar's reading of it beside, as a `Frame` carries `events`:

```ts
type RequestBody =
  // …prompt | steer | queue | abort | dispose
  | { kind: "answer"; requestId: string; decision: AppDecision }   // Session.answer
  | { kind: "native"; type: string; native: unknown; ask?: AppAsk }; // a toApp request

type AppAsk =
  | { kind: "tool_approval"; tool: string; callId?: string; title?: string; reason?: string;
      input?: string; command?: string; cwd?: string; paths?: string[]; diff?: string;
      choices: AskChoice[]; denyMessage: boolean }
  | { kind: "question"; questions: AskQuestion[]; choices: AskChoice[]; denyMessage: boolean };

type AskChoice = "allow" | "allow_session" | "deny" | "answer";
interface AskQuestion { id: string; question: string; header?: string;
  options: { label: string; description?: string }[]; multiSelect: boolean; other: boolean }
```

`ask` is present only when the request is a decision a person makes and oar
can read it; a terminal request, an MCP elicitation form, a token refresh
have none. Every field is read from the native body (or, for a codex file
change, from the item the request names); oar computes nothing, so a field
the runtime does not send is absent. `callId` joins the ask to the
`tool_call_started` of the call it gates. `choices` lists the typed
decisions the request takes; `denyMessage` says whether a deny's message
reaches the model.

| Runtime request | `ask` | `choices` |
|---|---|---|
| claude `control_request` `can_use_tool` | `tool_approval`: `tool_name`, `tool_use_id`, `title` or `description`, `decision_reason`, `input`, Bash `input.command`, `blocked_path` / `input.file_path` / `notebook_path` / `path` | `allow`, `allow_session` when claude suggests an allow rule (and does not suppress it), `deny`; `denyMessage: true` |
| claude `can_use_tool` for `AskUserQuestion` | `question`: `input.questions`, `id` = the question text, `other: true` | `answer`, `deny`; `denyMessage: true` |
| codex `item/commandExecution/requestApproval` | `tool_approval`: `commandExecution`, `itemId`, `reason`, `command`, `cwd` | `allow`, `allow_session`, `deny` |
| codex `item/fileChange/requestApproval` | `tool_approval`: `fileChange`, `itemId`, `reason`, the item's change paths and diffs | `allow`, `allow_session`, `deny` |
| codex `item/tool/requestUserInput` | `question`: `questions`, `id` = question id, `other` = `isOther` | `answer` |
| ACP `session/request_permission` (kimi) | `tool_approval`: tool call `kind` (else `title`), `toolCallId`, `title`, the `content` text as `reason`, `rawInput`, `rawInput.command` / `cwd`, `locations` | `allow` if an `allow_once` option is offered, `allow_session` if an `allow_always` one is and the profile knows it is session-scoped (kimi), `deny` if a `reject_once` one is |
| codex `item/permissions/requestApproval`, MCP elicitation, dynamic tool calls, claude's other control requests, ACP `terminal/*` | none | native answers only |

## Answering: `Session.answer(requestId, decision)`

```ts
type AppDecision =
  | { kind: "allow"; scope?: "once" | "session" }
  | { kind: "deny"; message?: string }
  | { kind: "answer"; answers: Record<string, string | string[]> }  // by AskQuestion.id
  | { kind: "native"; native: unknown };                            // the runtime's own reply payload
```

An answer is a control like the others, recorded by the kernel for every
adapter the same way:

```
seq=40  ◆ request   toApp      id=perm-1  can_use_tool {…}  ask: tool_approval Bash "touch x"
seq=41  ◆ request   toRuntime  id=rq-9    answer {requestId: perm-1, decision: {kind: "deny"}}
seq=42  ◇ response  →perm-1    answered {native: <the reply exactly as sent>}
seq=43  ◇ response  →rq-9      accepted
        ↳ the toApp request is settled before the answer is accepted; the
          answered response sits at the request's envelope (its session,
          its agentPath). What the runtime does next is in the stream.
```

A refused answer leaves the request as it was and is answered `rejected`
with one code (the `control_rejected` event reads it, `action: "answer"`):

| Code | When |
|---|---|
| `unknown_request` | the stream holds no `toApp` request with that id |
| `already_answered` | the request has its answer (automatic, or an earlier `answer`): the first one stands, so two devices racing get one accept and one rejection |
| `withdrawn` | the runtime withdrew it (`app_request_withdrawn`) |
| `runtime_exited` / `disposed` | the reachability rule of [record-stream.md](record-stream.md) |
| `unsupported` | the decision is not in `ask.choices`, a `deny` carries a message where `denyMessage` is false, a typed decision names a request with no `ask`, or the adapter answers that request itself |
| `error` | the delivery threw |

The typed decisions become each runtime's own reply:

| Decision | claude (`control_response` → `response`) | codex (JSON-RPC `result`, the server's id) | ACP (`RequestPermissionResponse`) |
|---|---|---|---|
| `allow` | `{behavior: "allow", updatedInput: <input>}` | `{decision: "accept"}` | `{outcome: {outcome: "selected", optionId: <allow_once>}}` |
| `allow`, `session` | same, plus `updatedPermissions`: claude's own `addRules` and `addDirectories` suggestions with `destination: "session"` (never its `setMode`) | `{decision: "acceptForSession"}` | the `allow_always` option, where session-scoped (kimi) |
| `deny` | `{behavior: "deny", message: <message> ?? "The user denied this tool use."}` | `{decision: "decline"}` | `<reject_once>` option |
| `answer` | `{behavior: "allow", updatedInput: {...input, answers: {<question>: "<label>, <label>"}}}` | `{answers: {<id>: {answers: [...]}}}` | unsupported |
| `native` | the object as `response` | the value as `result` | the object as the reply |

## A request never looks pending forever

A `toApp` request is open until the stream says otherwise:

- **answered**: its `answered` response (a host's answer, or oar's own:
  the YOLO grant, a hosted terminal's output, ACP's protocol-required
  `cancelled`);
- **withdrawn**: an `app_request_withdrawn {requestId}` event, the
  runtime's own word that it no longer waits (claude
  `control_cancel_request`; codex `serverRequest/resolved` for a request oar
  had not answered, which follows `turn/completed` of an interrupted turn);
- **void**: the stream holds the process exit; nothing can answer it now.

`abort` on a turn a request holds: claude withdraws the request before its
interrupt reply; codex reports `interrupted` and then resolves it; an ACP
adapter answers it `cancelled` itself, as ACP requires of a client that
cancels a turn. `dispose` ends in the exit either way.

```
seq=50  ◆ request   toApp      id=7      item/commandExecution/requestApproval  ask: tool_approval
seq=51  ◆ request   toRuntime  id=rq-12  abort
seq=52  ◇ response  →rq-12     accepted
seq=53  ✓ frame     turn/completed        → turn_ended aborted
seq=54  ✓ frame     serverRequest/resolved → app_request_withdrawn 7
```

## Folds

- `status()`: `awaiting?: string[]` on `running` (and `idle`, for work
  outside a turn) lists the open requests that carry an `ask`, beside the
  phase (the gated tool's `{tool, callId}`), absent when none. `stallOf`
  reports no stall while it is set; an `answered` response moves the clock.
- `SessionView.pendingRequests`: the open `toApp` requests, each with its
  `body` and `ask`; the `app_request` part in flow gets `settled:
  "answered" | "withdrawn" | "void"` (and keeps `answered`) once it leaves.

## Invariants

Pinned by `sea-trial/cases/session-approvals.ts` on every backend:
`approvals: "ask"` opens exactly where declared supported and names the
reason elsewhere; an answer to an unknown request is a recorded
`unknown_request` rejection; a gated action holds its turn (`awaiting`,
pending) until answered, a second answer is `already_answered`, and a deny
lets the turn go on to the runtime's own end; after an abort the request is
withdrawn or answered, and after a dispose it is void, and an answer then is
rejected.
