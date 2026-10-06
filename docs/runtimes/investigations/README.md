# Runtime investigations

**Reference only; no OAR adapter.** Live-probe investigations of runtimes OAR
does not integrate, kept to widen the sample for abstraction design. Each
records what was observed on one machine, on one version, through the
runtime's own interfaces; none is a mapping into OAR.

They follow the [runtime pages](../README.md) conventions: an evidence-baseline
paragraph up front, vendor declarations labelled and kept separate from
observations, blockers recorded as blockers rather than resolved by reading
source, and versions as evidence baselines rather than a support range.

| Investigation | Probed interface | Read for |
|---|---|---|
| [goose](goose.md) | `goose acp` stdio and `goose serve` HTTP + WS, `sessions.db` | ACP capability negotiation and its honesty gaps, mutable rows as the only truth, per-connection event streams with no broadcast, no cursor of any kind |

These are archived investigation reports from PR #19. Probe scripts and raw
artifacts were not included in that PR, so the reports are not independently
reproducible from this directory and do not establish support guarantees. A
page leaves this directory only if its runtime gains an adapter; until then,
comparisons drawn from these pages do not imply an implementation plan.

## Reading the hosted and remote evidence across samples

Four runtimes were probed live on this machine. Codex, Claude Code and opencode
have OAR adapters, so their observations live on the adapter pages; this index
points at all four rather than restating them.

| Sample | Where the live-probe evidence lives | Probed surface |
|---|---|---|
| Codex CLI 0.153.4 | [runtimes/codex.md](../codex.md), section "Native storage and listing, probed live" | app-server control socket, a WebSocket over AF_UNIX, against an isolated `CODEX_HOME` |
| Claude Code 2.1.237 and 2.1.261 | [runtimes/claude.md](../claude.md), section "Native identity, the peer registry, and declared capability, probed live" | `~/.claude` on-disk state and the per-process peer sockets |
| opencode 1.18.30 | [runtimes/opencode.md](../opencode.md), section "Addressability, resumability floor, and resume material" | `opencode serve` REST and SSE, `opencode.db` |
| goose 1.50.0 | [goose.md](goose.md), section "Identity and multiple observers" | `goose acp` stdio and `goose serve` HTTP and WS, `sessions.db` |

Three rules govern how those sections are read together. They are rules for
comparing, not claims about any one runtime.

**Connection identity and cursor are orthogonal.** Whether a connection can be
named on the wire says nothing about whether a stream can be resumed from a
position, and the reverse. Codex has no addressable connection id yet has a
rollout ordinal; goose has an explicit `acp-connection-id` yet no cursor of any
kind.

**The connection identity column records on-wire addressability, not
existence.** An id that exists server side but that no request or notification
can name is recorded as implicit, not as an id. Codex forces this:
`logs_2.sqlite` carries a persistent `connection_id`, and the contract offers
no way to address it.

**Acknowledgement, persisted preference and runtime state are three faces, and
they can disagree.** Every capability claim has to name the face its evidence
came from. Codex remote-control reports `enabled` from the CLI while the
persisted preference is `None` and the runtime state has already gone
`Connecting -> Errored`; reading only the first face gives an entirely wrong
answer. The same split is why log completeness is recorded per persistence
surface, and why an unfinished tool call is written `unknown` or `in-flight`
rather than forced into `failed`.

In OAR terminology, **resume** restores runtime model context and **replay**
redelivers OAR records to observers; native APIs may use these words
differently. Mutable message rows can be resume material without an
append-only frame log; report untested context restoration as unverified, not
absent.
