# Cybion

**Community runtime** (`@botiverse/oar/community`), maintained by the adapter's
contributor. Cybion ([cybion.ntnl.io](https://cybion.ntnl.io)) is an agent
harness platform: a **Thread** is a server-side agent conversation that keeps
its own context, Manuals, notes and scheduled checks, and runs its tools on the
owner's registered devices (**Workers**) rather than in the caller's process.

## Native concepts and calling interfaces

Cybion owns four objects this adapter touches:

| Native object | What it is |
|---|---|
| **Thread** | The conversation: model, reasoning effort, loaded Manuals, history, token usage. Persistent and resumable from any client. |
| **Input request** | One user message handed to a Thread. The Thread takes one at a time; a running Thread is `status: running`. |
| **History record** | One append-only row of the Thread (`input`, `response_output`, `tool_output`, `activity`, `checkpoint`). `response_output` payloads are Responses API output items (a message, a reasoning item, a function call). |
| **Worker** | A registered device; the Thread's tools (bash, browser, computer use) run there, not in the OAR host. |

The selected interface is Cybion's **Agent API** (`/v1/threads`), authenticated
with an API key (`Authorization: Bearer cyb_<user id>_<secret>`):

| Call | Meaning |
|---|---|
| `POST /v1/threads` | Create an empty Thread (`title`, `model`, `reasoning_effort`, Manuals, budgets). |
| `GET /v1/threads/{id}` | The Thread view: `status` (`running`/`idle`/`failed`), `display_status` (`ready`/`running`/`compacting`/`completed`/`stopped`/`blocked`/`failed`), usage totals, last context size. |
| `GET /v1/threads/{id}/history` | The whole history, oldest first. |
| `GET /v1/threads/{id}/response` | The latest inference's response snapshot (output items, usage, completion). |
| `POST /v1/threads/{id}/inputs` | Hand one input to the Thread; answers `{thread_id, record_idx, status}`, where `record_idx` is the record the input occupies. Takes `images` as png/jpeg/webp/gif base64 data URLs. |
| `POST /v1/threads/{id}/context` | Append background the integration already holds; starts no turn. |
| `POST /api/threads/{id}/cancel` | Stop the Thread's turn, answered with the stopped Thread. Cybion's own UI calls it, and an API key authenticates on that router too. |

The `/api` router is not closed to an API key: it authenticates the same bearer
credential, which is how `abort` reaches `cancel`. What OAR does not use is the
rest of it — Thread editing (model, effort, budget), model listing and account
usage have no OAR member to carry them.

## High-level mapping to OAR

| OAR | Cybion |
|---|---|
| `Session.id`, `SessionOptions.resume` | The Thread id. A resumed session is the same conversation, kept by Cybion. |
| `SessionOptions.name` | The Thread title at creation. |
| `SessionOptions.model` / `effort` | `model` / `reasoning_effort` at creation. |
| `prompt` | `POST /v1/threads/{id}/inputs`, then the Thread is followed by polling. |
| `steer` | The same `POST /v1/threads/{id}/inputs` while a turn runs: Cybion cancels the request in flight and appends the input to that turn, which stays `running` and ends once. |
| `queue` / `withdraw` | Held by the adapter (`queue.durable: false`); sent when the Thread goes idle. |
| `turn_ended` | The Thread's own `status` leaving `running`, read after two quiet polls. |
| `text_delta`, `reasoning`, `tool_call_started`, `tool_call_ended` | One history record each: a `message` item, a `reasoning` item, a function/custom-tool call, its `tool_output`. |
| `user_message` | The Thread's own `input` record (evidence `conversation`). |
| `usage` | The Thread's totals less the ones it carried when the session opened, plus `context_tokens` as context fullness. |
| `abort` | `POST /api/threads/{id}/cancel`; the turn then ends through the Thread's own `stopped` status. |
| `dispose` | Records the release; the Thread outlives the session by design. |

## Capability details

### Creation and resume

`session()` creates an empty Thread, or attaches to an existing id with
`resume`. There is no working directory to carry: the Thread runs on its
owner's Workers, so `cwd` is not transmitted and `additionalDirectories` is
refused rather than ignored. `model` and `effort` are read back from the
Thread; a value that differs from the stored one on resume is refused with an
`UnsupportedOptionError`, because no Agent API route changes either.

### Prompt, steer, queue and cancel

One turn at a time: `prompt` is rejected `busy` while the status fold says
running, while a turn is followed, while input is held for a later turn, and
while a held input's dispatch is in flight — the tracker alone would be too
late, because it learns of a turn only once `/inputs` answers. `queue` is held
by the adapter and sent when the Thread idles, and `withdraw` exists for the
same reason: Cybion's own queue belongs to the browser's Thread, so a queued
input there would become a second turn the status cannot tell from this one.

`steer` is native, and it is the same route: an input written while a turn runs
is **superseded into that turn**. Cybion cancels the request in flight — the
Worker tool call, the inference request — writes the cancelled request's late
output as an `activity` record, and re-enters the loop with the new input; the
Thread never leaves `running`, so one `turn_ended` covers both inputs. The
adapter therefore sends the input and leaves the followed turn alone instead of
starting another one. Only a turn that ended just before the write landed
leaves the input starting a turn of its own, which the tracker then follows.
With nothing running, `steer` answers `no_active_turn` rather than queueing.

Two consequences the stream shows honestly:

- The input the steer superseded is not dropped: its own `input` record stays in
  the history and the model's next inference reads it, in the same turn.
- A tool call cancelled this way gets **no** `tool_output` record, so the stream
  holds a `tool_call_started` with no `tool_call_ended`. OAR reports what
  Cybion wrote and does not invent an end.

`abort` calls `POST /api/threads/{id}/cancel`, the route Cybion's own UI uses;
it answers the stopped Thread, and the turn ends through that Thread's own
`stopped` status, so OAR reports `aborted` from the status and not from the
answer. Only a turn the tracker follows can be aborted: with nothing running,
the answer is `no_active_turn`.

### Events, history and children

Cybion's Agent API streams nothing: a turn is followed by polling
`GET /v1/threads/{id}` (status and usage) and `/history` (records). Every
history record newer than the ones this process already recorded becomes one
frame carrying the record verbatim; the events oar reads out of it are a
projection (`projection.ts`). Because the history is append-only, no record is
recorded twice, and an item whose payload the mapping does not interpret still
enters the stream with its own frame type and no events.

The stream starts at this process's own first turn: a resumed session does not
replay the Thread's earlier records, so `reduceConversation` over a resumed
session shows only what it observed.

A Cybion Thread has no native sub-agents, so `attribution` is `none`: a call the
model makes to another Thread through its own tooling is a tool call, and no
lineage edge is claimed.

### Models, tools and permissions

No `listModels`, no `accountUsage`, no inventory: the Agent API exposes none of
them, and `defineRuntime` answers `unsupported` for the inventories it does not
declare. Tools are Cybion's own (Worker bash, browser, computer use) and are
configured in the deployment, not per session, so `mcpServers`,
`disallowedTools` and `systemPrompt` are refused.

The Thread runs with its owner's configuration: sessions here are not YOLO in
the sense the rest of OAR means, because the caller is not the machine the
tools run on.

### Installation

The adapter is bundled with the host: there is no executable to probe, and
`installation()` answers `{kind: "available", via: "bundled"}` without I/O. The
deployment URL and API key are constructor inputs
(`createCybionRuntime({baseUrl, apiKey})`), so the adapter holds no credential
of its own.

## Known gaps

- **Polling, not streaming.** Text arrives at poll granularity (250 ms, backing
  off to 2 s), so a UI shows it in chunks rather than as a token stream, and a
  turn's end is observed a poll or two late.
- **Every poll reads the whole history.** `/history` on the Agent API takes no
  `after` or index parameter, so each poll of a long Thread reads everything it
  holds. That is fine for tens of records and wasteful for thousands; the cost
  is the deployment's bandwidth, never model tokens.
- **A resumed session does not replay the Thread's earlier records.** The stream
  starts at the resumed session's own first turn, so `reduceConversation` over
  it shows only what that process observed.
- **No model list, account usage or inventories.** The Agent API exposes none of
  them, so `listModels`, `accountUsage` and the four inventories answer
  `unsupported`.
- **A create that runs a different model or effort leaves a Thread behind.** The
  open fails, as it should, but the Thread already exists and the Agent API has
  no delete route, so it stays in its owner's list.
- **A turn that dies without writing a record is reported after about 111 s.**
  The started-guard waits 60 polls, and the backoff is capped at 2 s. A prompt
  answers `busy` until it gives up. `abort` does not wait: it sends the cancel,
  and a Thread the cancel stopped ends the turn as `aborted` at the next poll
  whether or not it was ever seen running.
- **A superseded tool call ends nowhere in the stream.** Cybion cancels the
  Worker call and writes no record for it, so the `tool_call_started` of a call
  a steer cancelled stays open in the record stream.
- **A steer that arrives after the turn ended starts a turn of its own.** With
  no turn followed, `steer` answers `no_active_turn` and writes nothing. If the
  turn ends while the write is already travelling, Cybion takes the input and
  starts a turn for it; the adapter then records that turn's start as a prompt
  request (nothing is re-sent) and follows it, so the stream holds a
  `turn_started` after the accepted steer, and the caller asked to steer and got
  a new turn.
- **Images travel inline.** `InputOptions.images` are read from this machine and
  sent as png/jpeg/webp/gif data URLs, within Cybion's count and size limits.

## Evidence and verification

- Native source: Cybion's `src/cloud.rs`, the `external_api` router
  (`/v1/threads`, `/v1/threads/{id}`, `/history`, `/response`, `/inputs`,
  `/context`) and the `history_records` kind constraint
  (`input`, `response_output`, `tool_output`, `checkpoint`, `activity`).
- Tests: `tests/community/cybion/` (the history projection, and a session
  driven against a scripted deployment) run with `OAR_COMMUNITY_TESTS=1`.
  Community tests are outside CI by default, as for every contributor runtime.
- **Wire probe, observed 2026-11-18** (`pnpm tsx
  experiments/cybion-agent-api-probe.ts`): a whole turn driven by this
  repository's own adapter over real HTTP against a local server speaking the
  shapes above — `POST /v1/threads {"title"}` → `GET /{id}/history` →
  `POST /{id}/inputs {"input"}` → polling `GET /{id}` and `/history` — reported
  `turn_started`, `user_message`, `text_delta`, `tool_call_ended`, `usage` and
  a `turn_ended` `completed`, with the Thread's totals (`21`/`6`) and context
  fullness (`23`) read back. So the client, the polled tracker and the session
  lifecycle are exercised end to end over a socket, not only against a stubbed
  `fetch`.
- **Live deployment handshake, observed 2026-11-18** against
  `https://cybion.ntnl.io`: `/health` answers `200`; `POST /v1/threads` without
  a key answers `401 {"error":"Bearer token is required"}`, and with a
  malformed `cyb_` key `401 {"error":"invalid user credential"}`, which the
  adapter surfaces verbatim as the session's error. The route, the auth header
  and the error shape are therefore the real deployment's, not a mock's.
- **Live turn, observed 2026-11-18** against `https://cybion.ntnl.io` with an
  Agent API key: one real turn on a real Thread. `POST /v1/threads` created it,
  the prompt's input record arrived, and the session reported `turn_started`,
  `user_message`, `text_delta` (the model's own answer), `usage` and a
  `turn_ended` `completed`, then went idle with totals
  `{input: 9916, output: 3, cacheRead: 5248}`. The Thread's history held
  exactly the kinds the mapping expects: one `input` (string `content`), two
  `activity` records (`manual_loaded`, which the mapping leaves
  uninterpreted and records as frames with no events), one `request_tail`
  activity, and one `response_output` `message` carrying an `output_text`
  part.
- **Live turns with tools, a queued input and a resume, observed 2026-11-18**
  on Cybion `0.6.108` at `https://cybion.ntnl.io` (that deployment's version,
  from `GET /api/config`), Thread `01a1f066-4924-7d40-861d-83e5ca373ed6`:
  - a turn that called a Worker tool reported `reasoning`,
    `tool_call_started` / `tool_call_ended` pairs and the model's own answer,
    then `turn_ended` `completed`;
  - an input queued while a turn ran was dispatched as a prompt of its own and
    ran its own turn, so three inputs produced three `turn_started` events;
  - a second session opened with `resume` on the same Thread reported the same
    id, model and effort, and its prompt ran in the same conversation.

  Usage across those turns read `{input: 78598, output: 647, cacheRead: 59392}`.
- **Cancellation, observed 2026-11-18** on Cybion `0.6.108` at
  `https://cybion.ntnl.io`: `POST /api/threads/{id}/cancel` with an API key
  turned a `running`/`running` Thread into `idle`/`stopped` in one answer, and
  an earlier `GET` on the same path answered `405` where `/v1/.../cancel`
  answered `404 route not found` — the route exists on the `/api` router only.
  Driven through this adapter, aborting a turn whose tool call was sleeping
  answered `accepted` and the turn ended `aborted` 2.2 s later, from the
  Thread's own `stopped` status.
- **Mid-turn input, observed 2026-11-18** on Cybion `0.6.108` at
  `https://cybion.ntnl.io`, Thread `01a1f0b1-745a-7e33-8b87-516f8c936cfd`: a
  turn running a `bash sleep 40` tool call took a second input at the API. The
  Thread's status stayed `running` from that write to the end — the timeline
  read `running` before the write and `idle`/`completed` after it, with no
  return to `idle` in between — and the history shows the shape the mapping
  claims: `input` (the prompt), the reasoning and function-call items, the
  `input` of the steer, then one `response_output` `message` answering the
  steer. The in-flight `bash` call got no `tool_output`. So one turn, one end,
  and the superseded output is not in the conversation as text. The same route
  driven through the adapter, `pnpm tsx experiments/cybion-agent-api-probe.ts`
  on Thread `01a1f0b7-e6e4-7b51-a1c9-e4e7383213bd`, printed
  `steer accepted status=running` and then `ended+1 started+0` for the turn the
  steer continued.
- **Unresolved**: what a `blocked` Thread's end means (the mapping reports
  `unknown` rather than guessing a limit). A Thread also outlives its session —
  the Agent API has no route that deletes one — so a probe leaves a Thread in
  its owner's list.
