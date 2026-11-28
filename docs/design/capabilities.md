# Capabilities

A host picks the runtime at run time, from a user's choice or its own
configuration, so its code cannot know which runtime it holds. Runtimes
differ: some take no system prompt, some resume a session only in the
directory it was created in, some cannot steer, and the answer can change
with the installed version. Which runtime does what is data, kept in one
place ([runtime matrix](../spec/runtime-matrix.md)); this page is about how
a host reads it. The design question is how a host learns what it may ask
for, and what happens when it asks for more.

**The position: a host never gets something other than it asked for, never
parses prose to learn why, and never names a runtime to decide.** Three
tools, each used only where the one before does not fit.

## 1. A whole operation is a member that may be absent

When a runtime either can or cannot do a whole thing, the thing is an
optional member and its presence is the capability. `Runtime.accountUsage`,
`redeemLimitReset`, `inspectLimitResets`, `listModels`, `installPlan`,
`install`, `checkUpdate`, `upgrade`, `login`, `logout`, `authStatus`,
`providers` and `sideQuestion` work this way, and so do the optional `Session` members
(`steer`, `withdraw`, `stopTask`, `compact`, `resources`,
`contextBreakdown`, `goal`, `lastModelRequest`, `nativeSessionFile`). A session that cannot steer has no `steer`;
one whose queue OAR does not hold has no `withdraw`; one OAR has no memory
reader for has no `resources`. A session without structured native goal
controls has no `goal`; enabling that native feature is an explicit session
choice. Each member's comment in `contracts/` says where it is absent.
TypeScript makes every caller handle the absence, and the check works the
same for a runtime chosen at run time: it reads the member, not a name.

No flag sits beside such a member. A flag could disagree with the member; the
member cannot disagree with itself.

## 2. An option nobody can drop is refused with a typed error

`session()` exists on every runtime, so what differs is its options. An
option a runtime cannot honor makes `session()` reject with
`UnsupportedOptionError` (the `option`, and the reason as its message; the
host knows which runtime it called), never a session that quietly runs
without it. A host may simply
try and fall back on that error; it needs no list to do so.

The error is for an option the runtime cannot take at all (an ACP model
without a `thought_level` selector has no effort channel); a value it refuses,
such as an effort level the model does not offer, is a plain error naming the
value. The error says which option, so a host can tell "not this runtime" from a failed login or a network error
without reading the message. Where the
runtime's own word decides (kimi's directory comes from its `session/list`),
the adapter throws the same error.

An existing model confirmation that cannot establish the requested selection
throws `ModelConfirmationError`, with requested/reported values and catalog
selectors only when actually read for that check. A host can offer another
selection without parsing prose; this does not establish that the model is
unavailable. The contract belongs to `contracts/`, while each adapter owns
its native confirmation and matching policy. See
[model confirmation failures](../spec/runtime-matrix.md#model-confirmation-failures).

## 3. A declaration only where a host must decide before acting

Some decisions come before any call: rowrow passes `env` to every session
and must leave it out for a runtime that refuses it; a UI shows an attach
button only where images go. For those, the runtime declares the fact up
front.

The answer for one installation is `installedSessionCapabilities(runtime,
installation)` (also `Runtime.sessionCapabilities`, and the lightweight
`@botiverse/oar/capabilities` entry, which loads no runtime SDK). It mirrors
what a session opened from that installation will offer (whether it has
`steer`, whether it takes `images`, whether `contextUsage()` is
trustworthy, and so on; the contract lists the fields), plus the complete
`refusedSessionOptions` for that version. A field is absent where only the
native handshake can tell, and absent means unknown, never false; the
opened session stays authoritative. A shared behavior case opens a session
and checks every declared field against it
([contract](../spec/runtime-matrix.md#session-capabilities-before-open)).

The static declarations it is built from, and the ones that do not depend
on the installation:

- `Runtime.refusedSessionOptions`: the options a runtime refuses at open
  on every version, each with its reason. A refusal that depends on the
  version is only in the installation's answer above.
- `Runtime.resumedSessionOptions`: measured timing for a different value
  supplied on resume and behavior when it is omitted. A host can decide
  whether its first input needs a reminder before a deferred system prompt
  takes effect. Undeclared entries are untested; refusals stay separate
  ([contract](../spec/runtime-matrix.md#resumed-session-options)).
- `Runtime.execution`: whether the adapter runs a native process or an
  in-process SDK, so a host can request isolation only for process runtimes
  without keeping a list of runtime names. Undeclared execution stays unknown;
  sharing support is checked separately at open
  ([placement contract](../spec/record-stream.md#placement-and-release)).
- `Runtime.installLines`: the parallel release lines a runtime installs
  (opencode `v1`, `v2`), so a host offers the choice OAR does not make
  before it plans an install; `install` answers `line_required` from the
  same list.
- `Runtime.minVersion`, `verifiedPlatforms`, `credentials`,
  `manualCompaction` and `mcpToolsListChanged`: what a host checks before it
  installs, signs in, or relies on compaction or tool-list changes.
- `Session.capabilities`: per-session facts that are not operations
  (`images`, `nativeMemory`, the `attribution` tier, whether held input is `durable`), some
  known only after the runtime's handshake.

A declaration is added for a real pre-action need, not mirrored for every
option. A refusal declaration is the same data the refusal reads: one shared check rejects a
declared option before anything starts, so the declaration and the behavior
cannot drift, and a test opens every declared refusal against the registry. Resume timing
is owned by the native runtime; vendor tests read each declaration and check
both supplied and omitted values against provider requests.

## A form for choosing settings

A host that lets a person set up an agent asks every runtime the same
question: which settings it takes, which values each may have, and how the
chosen values become `SessionOptions`. The runtime that owns a setting
answers, as plain data: `configForms` in `@botiverse/oar/forms` (Grok so
far). Hosts validate selected values and map them to session options. The entry loads no runtime SDK, so a server or a browser can render the
form for a runtime that is not installed there.

The form keeps the rules above:

- **Presence is the capability.** A runtime without a form has no entry, and
  a field the form does not list is not configurable.
  `refusedSessionOptions` says what a runtime refuses, not what a host
  should offer: a missing refusal is not a grant.
- **It states what the runtime accepts, and a host may only narrow it.** A
  host may drop options or make an optional field required, never add one.
  An added value would be the host's word, not the runtime's, and would
  reach `session()` only to be refused there.
- **Not enumerated is not none.** A model list that could not be read is a
  status with a reason, never an empty list and never a reason to clear a
  saved value. Where a runtime does not say what a model supports, the form
  offers nothing for it rather than guess.
- **A saved value survives a change it did not cause.** An edit keeps an
  unchanged stored value after the runtime's list or default moves. A launch
  never drops one: the host names a field it cannot map, and
  `session()` refuses a value the runtime no longer accepts.

How a host stores a configuration stays the host's. Contract:
[config form](../spec/config-form.md).

## A runtime's own settings

A setting only one runtime has is never a field of the shared contracts.
Where it goes depends on how long it holds:

- **For the host's lifetime** (where an SDK loads from, an executable path,
  a data directory): an argument of that runtime's own constructor,
  `createXxxRuntime(options)`, typed by that runtime alone. Constructors
  share no shape. For example, cursor needs its SDK, a package the host
  installs (`createCursorRuntime({ sdk: () => import("@cursor/sdk") })`),
  and Pi Durable needs the host's open Harness and Models
  (`createPiDurableRuntime({ harness, models })`); the full list is the
  `create*Runtime` exports.
  A runtime gets a constructor when it first needs one; for a built-in
  runtime, calling it without arguments gives the built-in one. The process environment
  knobs `OAR_CODEX_BIN`, `OAR_CODEX_SANDBOX` and `OAR_PI_AGENT_DIR` are
  settings of this kind; they move into constructors when a host first needs
  them per instance.
- **For one session**, use the smallest option for the verified capability.
  `SessionOptions.goals: true` enables structured native goals; unsupported
  runtimes declare and refuse it. It is a shared concept even while few
  runtimes expose it. Omission and false preserve native defaults and expose no
  `Session.goal` member. Enabling changes the model's tool set, so it is not
  implicit. No runtime-keyed `native` namespace or parallel capability flag
  is needed for this option ([contract](../spec/goals.md)).
  `SessionOptions.endTurnProcessesOnAbort: true` follows the same pattern:
  unsupported runtimes declare and refuse it, and omission and false change
  nothing ([contract](../spec/runtime-matrix.md#ending-a-turns-processes-on-abort)).
  `SessionOptions.ephemeral: true` follows the same pattern for non-persisted
  sessions: unsupported runtimes (and Codex installations below its verified
  `0.169.0` floor or with an unknown version) declare and refuse it, while
  omission and false preserve native persistence
  ([contract](../spec/runtime-matrix.md#refused-session-options)).

A package the host installs is handed over, never looked up. Written in the
host's own code, `import("@cursor/sdk")` fails the host's compile when the
package is missing (`skipLibCheck` cannot hide it), checks the SDK's types
against what OAR uses, and is visible to a bundler; a lookup inside OAR
would fail only at run time. One form hands over a location instead of a
module: cursor's subprocess execution
(`createCursorRuntime({ execution: "subprocess", sdkModule: import.meta.resolve("@cursor/sdk") })`)
loads the SDK in a child process, which cannot receive the host's loaded
module (plain data still crosses over IPC). The host still names the
package in its own code: written as `import.meta.resolve("@cursor/sdk")`, a
missing package fails when the host runs that line, not inside OAR; a
location passed as a plain string fails only at the first call that starts
a child. The types are not checked against `CursorSdk`, and a bundled host
must keep the package on disk where that location points. OAR still never searches for
it ([cursor](../runtimes/cursor.md#execution-modes)). `defaultRuntimes` holds what OAR
can build without the host, and a host adds the rest to a registry of its
own, the way Ferry and rowrow already add their test runtimes.

## Finding it

A developer reaches the capability from the call they are about to make,
the way OpenDAL's `ReadOptions::if_match` doc names
`Capability::read_with_if_match` and the error it returns:

- each refusable `SessionOptions` field says which runtimes refuse it and
  that the refusal is an `UnsupportedOptionError`;
- `SessionOptions` states the rule: what a runtime cannot honor is refused,
  never dropped;
- [runtime-matrix.md](../spec/runtime-matrix.md#refused-session-options)
  holds the table.

## Tests skip by capability

A shared behavior case that needs a capability skips when it is absent
(`session.steer === undefined`, `session.withdraw === undefined`, an
in-process `bundled` installation for the kill case), never by runtime name.

## What this refuses

- **One struct mirroring every operation and option.** OpenDAL keeps even
  whole operations (`read`, `list`) in its `Capability` struct because a
  type-erased Rust `Operator` cannot lose a method per service. TypeScript
  members can be absent, so OAR keeps the table for options only.
- **A static declaration of what only the runtime knows at open.** ACP
  image support comes from `initialize`, so it lives on the session. The
  one exception is evidence against the native flag: grok's `initialize`
  says `promptCapabilities.image: false` while its agent hands image blocks
  to the model, so the grok adapter declares images from that observation
  ([grok session](../../packages/oar/src/runtimes/grok/session.ts)).
- **Asking before trying, as a requirement.** A host that does not need to
  decide early just calls; the typed refusal is enough.

## Evidence

- OpenDAL main 95f7c8b: `core/src/types/capability.rs` (the struct and its
  naming rules), `core/src/layers/correctness_check.rs` (one check before
  any request, `ErrorKind::Unsupported`), `core/src/types/options.rs`
  (option docs that link the capability), RFC 2852 and RFC 7700 (a split
  native and full capability, then merged back into one effective
  capability because the split was misread).
- rowrow 0.3.25 reads `refusedSessionOptions.env` instead of naming cursor
  (#proj-rowrow, 2026-10-03).
- kimi 2.1.1 resumed in another directory kept running in the old one until
  OAR refused it ([resume in another directory](../runtimes/resume-cwd.md)).
- OAR 0.19.0 looked `@cursor/sdk` up itself: a host that forgot the package
  learned it only at run time, and with `skipLibCheck` its compile could not
  see it (#core, 2026-10-04). The clean install test now shows the host's
  compile failing instead ([test](../../tests/clean-install.ts)). Kysely
  takes the same line for database drivers: a dialect is handed the driver
  (`new PostgresDialect({ pool })`).
