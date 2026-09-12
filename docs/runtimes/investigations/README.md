# Runtime investigations

**Reference only; no OAR adapter.** Pages here are live-probe investigations of
runtimes OAR does not integrate. They exist to widen the sample used for
abstraction design: each one records what was actually observed on one machine,
on one version, through the runtime's own interfaces — not a mapping into OAR.

They follow the same conventions as the [runtime pages](../README.md): an
evidence-baseline paragraph up front, vendor declarations labelled as such and
kept separate from observations, blockers recorded as blockers rather than
resolved by reading source, and versions treated as evidence baselines rather
than a declared support range.

| Investigation | Probed interface | Read for |
|---|---|---|
| [opencode](opencode.md) | `opencode serve` REST + OpenAPI 3.1, `opencode.db` | Event sourcing beside mutable projections, client-declared session identity, `/sync/steal` and `/sync/replay` semantics, workspace as movable attribution |
| [goose](goose.md) | `goose acp` stdio and `goose serve` HTTP + WS, `sessions.db` | ACP capability negotiation and its honesty gaps, mutable rows as the only truth, per-connection event streams with no broadcast, no cursor of any kind |

A page graduates out of this directory only if a runtime gains an adapter; until
then, comparisons drawn from these pages do not imply an implementation plan.
