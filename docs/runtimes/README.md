# Runtime knowledge

The primary subject is each runtime's **programming interface for calling an
agent**: which operation to call, with what input and identity, what its result
means, and what the caller can observe or control afterward. Native concepts
explain those contracts; internals matter where they explain API behavior.

These pages connect **native concepts and calling surfaces → high-level OAR
mapping → per-feature details and evidence**. They support abstraction design as well
as adapter maintenance. A runtime can be useful design input even when it is
not an OAR backend or prospective consumer.

## Pages

| Runtime | Native entry used by OAR | Read for |
|---|---|---|
| [Claude Code](claude.md) | CLI print mode, bidirectional `stream-json` | Persistent conversations, user turns versus model steps, input delivery, native children, usage |
| [Codex](codex.md) | App-server v2 over stdio | Thread/turn/item identity, bidirectional requests, native queue, collaboration threads |
| [Grok](grok.md) | `grok agent stdio`, ACP plus vendor extensions | Prompt delivery, independent child sessions, client execution, context versus billing |
| [Kimi](kimi.md) | TypeScript kimi-code's `kimi acp` | Session/agent/turn distinctions, native KAP versus ACP visibility, completion and compaction |
| [Pi](pi.md) | Embedded `@earendil-works/pi-coding-agent` SDK | Agent run versus internal turns, history tree, session replacement, extension-dependent capabilities |
| [Maka](maka.md) | **Reference only; no OAR adapter** | Runtime Host client calls, continuation query/start, recovery identities and caller obligations |

The first review is dated **2026-09-08**, against OAR **`9b102d0`**. Each page
records its own native source, documentation, and observed binary versions.
Those versions are evidence baselines, not a declared support range. This
documentation review did not run new runtime tests or model calls.

## Read the mappings precisely

These are documentation labels, not a new capability API:

| Status | Meaning |
|---|---|
| Mapped / supported | The current adapter implements the stated operation. Read its limits and verification evidence; the label is not a universal compatibility claim. |
| Partial / projected | OAR carries some of the native behavior or information. The page names what is transformed, omitted, or constrained. |
| Not exposed / unexposed | The native feature exists, but there is no corresponding public OAR operation or record. Native configuration may still affect execution. |
| Unavailable on selected transport | The underlying runtime has information or control that the interface selected by OAR does not expose. Separate this from information OAR itself drops. |
| Unverified | The stated semantic guarantee has not been established by the cited evidence. An implemented method can still have an unverified interpretation. |
| Reference only | Design input from a runtime without a current OAR integration. Comparisons do not imply an implementation plan. |

Keep three layers distinct in every capability row: what the native runtime
can do, what its selected interface reveals, and what OAR actually carries.
For example, native session persistence does not imply OAR history replay;
having a `contextUsage()` method does not prove that cumulative token counts
measure current context occupancy.

## Evidence discipline

- **Native source or official documentation** establishes the native model
  and advertised protocol. Pin source revisions where possible; date rolling
  documentation and identify the relevant interface.
- **OAR implementation** establishes today's mapping. Follow executable paths
  rather than trusting an old comment or inferring support from a type alone.
- **Recorded observation** establishes what happened on the named version,
  configuration, and probe. Link the experiment or fixture and preserve its
  limits; do not silently generalize to a later binary.
- **Tests** establish particular assertions at a particular seam. Distinguish
  fake process/SDK fixtures, real runtime with a scripted model, and real
  authenticated calls. A test file or CI configuration is not a fresh pass.
- **Open questions and design implications** remain visibly separate from
  facts. Do not turn an attractive inference into a native guarantee.

## Questions each page should answer

1. What does the runtime own? Which objects have distinct identity, lifetime,
   persistence, and authority: process, session, thread, turn, run, item,
   request, tool call, child agent?
2. How does a program connect and call the agent: SDK, process protocol, or
   RPC? What are the concrete operations, inputs, results, errors, and
   asynchronous events? Which are public entry points versus internal APIs?
3. Which native interfaces expose those concepts, and which one does OAR use?
   What capabilities depend on version, configuration, extensions, or trust?
4. How does each native capability map into today's public contract? Include
   control, observation, interaction, history, tools, configuration, usage,
   and resource release; name missing capabilities explicitly.
5. Which distinctions must an abstraction preserve? What does an
   acknowledgement prove? Who owns retries or execution? What can be
   reconstructed from records, and what remains unknown?
6. What evidence validates those claims, and which focused probe would settle
   the most consequential remaining uncertainty?

For **resume**, always distinguish these questions: which token is persisted
and where it is valid; whether the call loads history, attaches to running
work, starts a continuation, or replays events; whether new prompt submission
is separate; what configuration is restored or overridden; and what happens
on missing identity, concurrent controllers, or an ambiguous response. Do
not infer one guarantee from another simply because the method is named
`resume`.

Use this page structure consistently:

1. **Native concepts and calling interfaces.** Introduce the runtime's own
   objects and lifetimes, then the available SDK/CLI/protocol entry points.
2. **High-level mapping to OAR.** Show how native objects, identities, control,
   and observation correspond to OAR. Keep this small enough to orient the
   reader before individual operations.
3. **Capability details.** Use separate subsections for creation/resume,
   prompt/steer/queue, cancellation/release, events/history/children,
   models/context, tools/permissions, and other relevant features. Each
   subsection connects the native API, OAR mapping, limits, and evidence.
4. **Evidence and verification.** Record source/observed versions, existing
   tests, and unresolved questions. A short review baseline may appear at
   the top; it should not displace the conceptual introduction.

Keep broader runtime design brief and tied to caller-visible behavior. Do not
force every runtime into an identical internal taxonomy or reproduce its
entire manual. Reference-only pages use the same outline and mark the OAR
comparison explicitly as unimplemented.

## Where this fits and how to maintain it

[`../design/`](../design/README.md) records OAR's design reasoning;
[`../spec/`](../spec/README.md) is the record-stream contract the
adapters implement. These runtime pages record native facts and **current
implementation** — which native frames become which records and views,
which controls are which requests, what each adapter declares in
`capabilities` — and may expose reasons to revisit either. A contract
guarantee is not evidence that a particular adapter honors it live; the
evidence sections say what was verified.
[`experiments/`](../../experiments/README.md) keeps reproducible live probes;
[`sea-trial/`](../../sea-trial/README.md) explains ongoing behavior validation;
the [source index](../../packages/oar/src/README.md) identifies implementation
ownership.

When an adapter change, dependency upgrade, or probe changes a mapping, update
its page in the same commit. Preserve uncertainty until new evidence resolves
it; replace stale conclusions rather than building a chronological diary.
Adding a runtime page updates this index and the root knowledge index.
Follow the [development workflow](../development.md) for implementation and
validation. These pages inform that work; they do not replace its tests.
