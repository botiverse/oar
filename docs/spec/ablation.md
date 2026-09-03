# Ablation ledger

> Part of the [v2 spec, draft v0.8](README.md). Method: element-wise
> deletion tests — for every element of the contract, try deleting it; if
> no concrete breaking scenario can be named, it is cut.

## What v0.8 cut

1. **`streamId` deleted.** It encoded the same attribution dimension as
   `agentPath` twice: always derivable as the `agentPath` leaf (`[]` =
   root), and v0.7's own text wrote the composite key as
   "(agentPath|streamId, id)", admitting interchangeability. Attribution
   is now the single field `agentPath`; the composite key becomes
   `(agentPath, id)`. `Cursor`'s `streamId?` filter went with it — no
   consumer ever demonstrated "resume just one sub-agent"; for a
   single-agent view, resume the whole stream and filter client-side by
   `agentPath`.
2. **`EventRecord.scope` deleted.** Defined, then referenced nowhere. The
   fix for pi's 17 dropped events comes from `spanId` being optional, not
   from `scope`.
3. **`SessionNode.kind` deleted.** Derivable from the in-edge: no in-edge
   = root, `fork` edge = branch, `tool_call` edge = derived child. The
   same information is not stored twice.
4. **Session graph narrowed to true sessions only.** A claude subagent is
   not a session; putting agent parent/child in the session graph
   violates the hard constraint in [attribution.md](attribution.md)
   (never merge the session and agent dimensions). Agent lineage is
   `agentPath` + the spawning `tool_call` record.
5. **`receivedAt` excluded from the replay-determinism guarantee.** A
   post-mortem rebuild cannot reproduce observation time; identity and
   positioning rest on `seq` alone — otherwise "the same record replayed
   twice gets the same seq" is unsatisfiable.
6. **New red line: `spanId` carries only runtime-native turn ids; oar
   never generates it.** Otherwise the synthesized turn boundaries
   deleted in v0.7 return through this field. (See the red lines in
   [runtime-matrix.md](runtime-matrix.md).)

Earlier cuts are recorded in the version lineage in the
[spec README](README.md): the `origin` self-disclosure label, synthesized
turn boundaries, usage basis labels, and `causedBy` (v0.7 — its deletion
is still open to reversal in review).

## What was tried and kept

Elements that went through the deletion test and stayed, each with the
concrete scenario that breaks without it — recorded so the next ablation
pass does not repeat the work.

| element | concrete breaking scenario if deleted |
|---|---|
| `seq` | Multi-client resumable reading simply ceases to exist; "did the abort land before or after that tool_result" becomes unsolvable. The foundation of serving multiple clients. |
| `agentPath` | The cross-agent ID collisions of hard spot 1 ([runtime-matrix.md](runtime-matrix.md)) have no solution (bare toolCallIds collide); kimi-cli's unbounded recursion loses its lineage — a single `parent` field cannot hold it. |
| `sessionId` | grok's child sessions interleaving on one connection cannot be demultiplexed. |
| `spanId?` | codex resume needs `expectedTurnId`; when a runtime has native turn ids, consumers can group by turn without parsing bodies. Cost contained: optional, plus the never-generate red line. |
| `direction` | toApp request bodies are runtime verbatim with an open vocabulary; without `direction` the server cannot decide "does the app need to answer this" for a body it does not understand. |
| `kind` | Theoretically derivable from field shape (kimi-cli's wire distinguishes by the presence of `id`), but TS discriminated unions need an explicit discriminant; deleting it means every consumer hand-writes shape checks. |
| the event/request/response split itself | Merging back into one model reproduces the root cause of v1's five defects (evidence A in [record-stream.md](record-stream.md)); the kimi-cli/codex isomorphism corroborates classification by obligation. |
| dangling-request semantics | Deleting them forces a guessed response to be backfilled after recovery, violating "oar never synthesizes". |
| session graph (after narrowing) | Deleting it orphans grok's child-session records — "where did sess-B come from" is unanswerable — and loses pi's fork lineage. |
| usage constraint + optional breakdown | Deleting the breakdown throws away the per-agent numbers claude/codex/grok already expose; deleting the constraint dumps the accounting-basis problem back on consumers — already ruled out ([attribution.md](attribution.md)). |
