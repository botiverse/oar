# Runtime investigations

**Reference only; no OAR adapter.** Pages here are live-probe investigations of
runtimes OAR does not integrate. They exist to widen the sample used for
abstraction design: each one records what was actually observed on one machine,
on one version, through the runtime's own interfaces, not a mapping into OAR.

They follow the same conventions as the [runtime pages](../README.md): an
evidence-baseline paragraph up front, vendor declarations labelled as such and
kept separate from observations, blockers recorded as blockers rather than
resolved by reading source, and versions treated as evidence baselines rather
than a declared support range.

| Investigation | Probed interface | Read for |
|---|---|---|
| [opencode](opencode.md) | `opencode serve` REST + OpenAPI 3.1, `opencode.db` | Event sourcing beside mutable projections, client-declared session identity, `/sync/steal` and `/sync/replay` semantics, workspace as movable attribution |
| [goose](goose.md) | `goose acp` stdio and `goose serve` HTTP + WS, `sessions.db` | ACP capability negotiation and its honesty gaps, mutable rows as the only truth, per-connection event streams with no broadcast, no cursor of any kind |

## Reading the hosted and remote evidence across samples

Four runtimes have now been probed live on this machine: Codex CLI 0.153.4,
Claude Code 2.1.237/2.1.261, opencode 1.18.30 and goose 1.50.0. Two of them have
OAR adapters, so their observations live on the adapter pages rather than here;
this section is the index into all four, and it deliberately does not restate
their contents as a second table.

| Sample | Where the live-probe evidence lives | Probed surface |
|---|---|---|
| Codex CLI 0.153.4 | [runtimes/codex.md](../codex.md), section "Native storage and listing, probed live" | app-server control socket, a WebSocket over AF_UNIX, against an isolated `CODEX_HOME` |
| Claude Code 2.1.237 and 2.1.261 | [runtimes/claude.md](../claude.md), section "Native identity, the peer registry, and declared capability, probed live" | `~/.claude` on-disk state and the per-process peer sockets |
| opencode 1.18.30 | [opencode.md](opencode.md), section "Addressability, resumability floor, and resume material" | `opencode serve` REST and SSE, `opencode.db` |
| goose 1.50.0 | [goose.md](goose.md), section "Identity and multiple observers" | `goose acp` stdio and `goose serve` HTTP and WS, `sessions.db` |

Three rules govern how those four sections are meant to be read together. They
are conclusions about how to compare, not claims about any one runtime.

**Connection identity and cursor are orthogonal.** Whether a connection can be
named on the wire says nothing about whether a stream can be resumed from a
position, and the reverse. Codex has no addressable connection id yet has a
rollout ordinal; goose has an explicit `acp-connection-id` yet no cursor of any
kind. Filling one column does not constrain the other.

**The connection identity column records on-wire addressability, not
existence.** An id that exists server side but that no request or notification
can name is recorded as implicit, not as an id. Codex is the case that forces
this: `logs_2.sqlite` carries a persistent `connection_id`, and the contract
still offers no way to address it.

**Acknowledgement, persisted preference and runtime state are three faces, and
they can disagree.** Every capability claim has to name the face its evidence
came from. Codex remote-control reports `enabled` from the CLI while the
persisted preference is `None` and the runtime state has already gone
`Connecting -> Errored`; reading only the first face gives an answer that is
entirely wrong. The same split is why log completeness is recorded per
persistence surface, and why an unfinished tool call is written `unknown` or
`in-flight` rather than forced into `failed`.

One naming convention is shared across the four pages. **resume** is the runtime
side, facing the model; **replay** is the OAR side, facing subscribers. A page
that records `none` for runtime side resume material is saying the runtime keeps
nothing a model turn can be resumed from, not that the session cannot be
replayed to a subscriber.

A page graduates out of this directory only if a runtime gains an adapter; until
then, comparisons drawn from these pages do not imply an implementation plan.
