# Layout, and why it is cut this way

Every directory here exists because a **decision** put it there. If you cannot
name the decision, the directory should not exist.

Status is stated per entry and is **not aspirational**: `written` means the
types exist and compile under the strict config; `empty` means the directory is
reserved by a decision and holds nothing yet. A reserved-but-empty directory is
recorded as empty rather than left to look finished.

## The two cuts that generate the layout

**Cut 1 — consumer vs implementor.** `src/index.ts` is the entire consumer
surface. A consumer sees a session and typed events; never a process, never a
raw stderr pipe. Everything under `src/backend/` is for whoever *implements* a
driver and is deliberately not re-exported.

**Cut 2 — OS axis vs runtime axis.** `Windows / POSIX` is orthogonal to
`claude / pi / codex`. Let the first leak into the second and you get 13 × 2
hand-written combinations. So process handling lives once under
`src/backend/process/`, and drivers hold protocol differences only.

## Map

| Chapter / concern | Path | Status |
| --- | --- | --- |
| 1 — Runtime interface, capabilities | `src/capability.ts` | written |
| 1 — Session handles (state-typed) | `src/session/handle.ts` | written |
| 2 — Calling interface (start/prompt/steer/interrupt/stop) | `src/session/handle.ts` | partly — operation set exists, `acceptedAs` not modelled |
| 3a — Outbound events, observation | `src/events/event.ts` | written |
| — Per-subject progress vs liveness | `src/events/progress.ts` | written — encodes the #757 incident |
| 3b — Interception & permission | `src/events/intercept.ts` | written (types only) |
| — Bounded scrubbed diagnostics | `src/events/diagnostic.ts` | written |
| 4 — Session & transcript | `src/transcript/` | **empty** |
| 5 — Capability negotiation | — | **not started** (follows ch.7) |
| 6 — Trust boundary / auth axis | `src/config/auth.ts` | written |
| 7 — Discovery & provisioning | `src/discovery/` | **empty** |
| Config options (the create-agent form's source) | `src/config/options.ts` | written |
| Process lifecycle (day-1, implementor utility) | `src/backend/process/lifecycle.ts` | written (types only) |
| Cross-cutting middleware (retry/timeout/tracing) | `src/backend/middleware/` | **empty** |
| Backend trait (what a driver implements) | `src/backend/trait.ts` | written — incl. Readiness and ShutdownProtocol |
| sea-trial — the conformance suite | `sea-trial/runner.ts` | written |
| sea-trial cases | `sea-trial/cases/` | **empty** |
| drydock — the no-daemon runner | `drydock/` | written (script/transcript/RuntimeUnderTest types) |

## Why `capability` and `config options` are two records

```
branch on it while DRIVING a session   -> capability   (src/capability.ts)
decide it BEFORE starting              -> config option (src/config/options.ts)
```

They are kept apart because they interact: a launch-time option may change what
is operationally possible. Fuse them and the question *"is this fixed at launch
or does it vary within a session?"* stops being expressible.

Note this is a **naming** decision as much as a structural one — `capability`
means *can it do something*, `config options` means *what you fill in*. One word
per meaning, so neither needs a qualifier.

## Why `sea-trial` is top-level rather than under `src`

It is not a test directory for this package; it is the conformance suite every
runtime must pass, and the thing that decides whether the abstraction is real.
Green across every driver means the abstraction holds. **Not green means we have
N special cases sharing a directory — and that finding is the return**
regardless of whether anything ships.

## What the strict config buys, demonstrated

Five negative controls have been run and each was red on the injected cell,
with green returning when removed:

```
prompt while busy       -> TS2339 Property 'prompt' does not exist on BusySession
missing event case      -> TS2322 tool_call not assignable to never
bypass the scrubber     -> TS2673 Constructor of Diagnostic is private
skip justifying nothing -> TS2322 Source has 0 element(s) but target requires 1
missing outcome case    -> TS2322 fail-variant not assignable to never
```

`as` is banned outright (`consistent-type-assertions: never`). The production
crash that motivated this project was one cast erasing an optional field;
without it every read site would have failed to compile.

⚠️ **Two lint facts that are easy to get wrong, recorded because I got both wrong:**

1. `consistent-type-assertions` defaults to `assertionStyle: "as"` — i.e. casts
   **allowed**. Enabling the rule by name alone lints clean while the ban is
   absent. It only bites with an explicit `"never"`.
2. `switch-exhaustiveness-check` **is** available, under `--type-aware` with
   `oxlint-tsgolint` installed. An earlier commit message here claims it has no
   oxlint equivalent; **that claim is wrong** and this line supersedes it.

Both share a shape: **a lint config that is green tells you nothing about
whether its teeth are present.** Every rule this repo relies on has a control
that proves it can fire.
