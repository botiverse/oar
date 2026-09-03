# Attribution and usage

> Part of the [v2 spec, draft v0.8](README.md). Related design pages:
> [hard problems 9–10](../design/hard-problems.md#attribution--the-most-underestimated-part),
> [foundations](../design/foundations.md).

## Attribution is a field on the record, not a transport channel

**Why:** sub-agent and parent-agent records interleave in the same stream,
and consumers must be able to answer "which agent does this record belong
to". That needs an attribution mark on the record (`agentPath`), not a
second transport channel. "Multiplexing" has always meant main and sub
agents sharing one stream — never multiple control planes.

Ablation note: v0.7 carried both `streamId` and `agentPath` — two
encodings of the same dimension. `streamId` was always derivable from
`agentPath` (the leaf element; `[]` meaning root), and v0.7's own text
already wrote the composite key as "(agentPath|streamId, id)", admitting
they were interchangeable. `streamId` is deleted; attribution is the
single field `agentPath`.

### Evidence — every shipped runtime is single-connection, with attribution as a frame field

- claude: `Task` can start parallel sub-agents; their messages are
  flattened into one stream-json output, linked by `parent_tool_use_id`.
  [sym]
- codex is isomorphic: one app-server connection + `parent_tool_use_id` +
  `subagent_tokens`. [sym]
- grok (ACP): a child has its own ACP sessionId but travels the same ACP
  connection. [src]
- kimi-cli (native wire): sub-agents open no new connection; the parent
  wire receives `SubagentEvent{parent_tool_call_id, agent_id,
  subagent_type, event}` wrapper records sharing the one `_write_queue`
  with ordinary events — attribution is literally a field on the record.
  [src: wire/types.py:242; subagents/runner.py:393-428]
- kimi-code 0.38 (native KAP over WebSocket): one connection + one
  session; the agent graph's key is `(session_id, agent_id)` and
  `agent_id` is a frame field. If attribution required a transport
  channel, KAP would need one socket per sub-agent — it does not.
  [src: kimi-code@0999454 ws-control.ts:35-180;
  sessionEventBroadcaster.ts:414-543]
- pi: no native sub-agents; naturally single-stream. [src]

Converse necessity: give each sub-agent its own transport stream and total
order is permanently lost — "did the abort land before or after that
tool_result" becomes unanswerable.
[record-stream.md](record-stream.md) already rejected dual channels for
this reason; attribution does not readmit them through the back door.

## The record envelope: self-certifying attribution

**Why:** every record must certify its own attribution (which session,
which agent), be orderable, and be locatable, so consumers can demux,
attribute, and resume. Each field's deletion-test verdict is in the
comments.

- The v1 envelope already had `sessionId` / `turnId` / `seq` /
  `receivedAt`; v2 adds `agentPath` and turns `turnId` into the optional
  `spanId`. [v1: contracts/session.ts:158-164]
- `sessionId` has a real referent — it is not invented by oar: claude's
  `CLAUDE_CODE_SESSION_ID`, codex's `CODEX_SESSION_ID`. Delete it and
  grok's child sessions interleaving on one connection cannot be
  demultiplexed. [env][src]

```ts
interface RecordEnvelopeV2 {
  sessionId: string;              // deletion test: grok child sessions interleave on one connection — undemuxable without it
  agentPath: readonly string[];   // [] = root; [...] = sub-agent lineage. Deletion test: the cross-agent ID collision (runtime-matrix.md, hard spot 1) has no solution
  spanId?: string;                // runtime-native turn id; v1's mandatory turnId dropped pi's 17 facts (record-stream.md, evidence A)
  seq: number;                    // monotonic, cursor basis; replay determinism covers seq only (session-graph-and-cursor.md)
  receivedAt: number;             // best-effort observation time; explicitly outside the determinism guarantee — identity rests on seq
}
```

### Example 4 · Parent/child interleaving + the composite key

```
seq=88  ✓ event  root          tool_call {id:"call_3", Task → spawn sub-agent}
seq=89  ✓ event  path=["a1"]   assistant_text "Let me check first…"
seq=90  ✓ event  root          assistant_text "Meanwhile I'll look elsewhere…"
        ↳ parent and child interleave in one stream; agentPath lets every
          record certify its own attribution
seq=91  ✓ event  path=["a1"]   tool_call {id:"call_1", …}
        ↳ sharing a name with a historical call_1 in the parent stream is
          fine: identity = (agentPath, id), and (["a1"],"call_1") ≠
          ([],"call_1"). See hard spot 1 in runtime-matrix.md
```

## The attribution spectrum: a protocol responsibility, not app-layer improvisation

**Why:** if attribution is not in the protocol, every app reimplements
parent linkage and token splitting, each inconsistently — and three
independent codebases already demonstrate the inevitable degeneration
(see the adapter red lines in [runtime-matrix.md](runtime-matrix.md)).

- claude/codex: `parent_tool_use_id` (linkage) + `subagent_tokens`
  (per-agent tokens) → direct mapping. [sym]
- grok (ACP): nested sessions; child has its own sessionId + per-child
  usage. [src]
- kimi (ACP): opaque — an internal graph exists, but the default ACP
  server subscribes only to the main agent. The protocol honestly marks
  root only; fabricating a child graph from display text is forbidden.
  [src]
- kimi-cli (native wire): full attribution, recursively unbounded
  (`SubagentEvent(event=SubagentEvent(...))`). Both of its offline
  consumers flatten the wrappers and lose attribution — and once
  flattened it is unrecoverable, which is why the protocol must guarantee
  attribution on the record. Unbounded recursion is also the evidence
  for `agentPath` being an array: a single `parent` field cannot hold the
  lineage. [src: wire/types.py:242; vis/api/sessions.py:28-42]
- kimi-code (native KAP): agent graph key = `(session_id, agent_id)`;
  every frame carries `agent_id`. [src]
- ACP's attribution gap: zero hits for `parent*` / `subagent*` / `child*`
  across four schemas — but the design level has been formally discussed:
  in org Discussion #690 real clients can only guess parent/child from
  `_meta` / `rawInput`; spec-repo draft PR #855 offers a candidate fix
  (child session + parentSessionId / parentToolCallId / subagentId),
  unmerged to date. Accurate status: "the gap is formally discussed, a
  candidate fix sits in a draft RFD, no protocol commitment yet". [acp]

**Hard constraint:** v2 must never merge session and agent into one
dimension. The ACP draft chooses child-session (#3); kimi-cli and
kimi-code choose record-level attribution (#2). Both topologies are real
candidates and v2 must express both — otherwise grok's child sessions can
only be faked as pseudo-agents, or KAP's agents faked as pseudo-sessions.

**Full-spectrum principle:** the protocol supports opaque (#1) →
attribution (#2) → nested-session (#3). oar carries only the structure
the runtime exposes and never fabricates (kimi stays opaque; `agentPath`
stays at root). Vendor escape hatches (grok's `_x.ai/*`) are per-runtime
capabilities declared explicitly on the oar side, not protocol
guarantees. [acp]

## Usage: one constraint

**oar guarantees that the externally exposed usage numbers are correct.**
The external shape: a session total, plus an optional per-agent
breakdown; the breakdown is deduplicated and directly summable (sum =
total). Which runtime view is authoritative and how to deduplicate —
grok's multiple overlapping views, claude/codex's `subagent_tokens`, pi's
flat usage — sinks entirely into each runtime adapter and never crosses
the protocol surface. `origin` and accounting-basis labels are deleted
from the protocol.

- Basis: a deliberate design ruling — applications don't primarily care
  about exact provenance reconstruction; they care about correct results
  and usability. Pushing runtime-vs-oar accounting bases onto every
  consumer is complex and unreasonable.
- Upstream corroboration: both ACP usage RFDs remain Draft, with open
  items verbatim including "Ambiguous totals", "Per-turn vs cumulative",
  "Cost separation". With the upstream basis unsettled, exposing basis
  labels at the protocol surface would only transfer an unsettled problem
  to consumers. [acp: session-usage.mdx; end-turn-token-usage.mdx:26,97,101]
- Usage itself is a seq-carrying event on the stream (the query rule in
  [record-stream.md](record-stream.md)); per-agent attribution rides the
  envelope. [sym][src]

### Example 7 · What external usage looks like

```
External (protocol surface):
  session total:              input 45_231 / output 8_120   ← guaranteed correct, usable as-is
  optional per-agent split:   root  30_100 / 6_050
                              a1    15_131 / 2_070          ← deduplicated; sums to the total
Adapter-internal (never crosses the protocol surface):
  grok    multiple overlapping views → adapter picks the authoritative one and dedups
  claude  subagent_tokens            → adapter merges into the breakdown
  pi      flat usage                 → session total only; no fabricated breakdown
```
