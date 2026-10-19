# Capabilities

A host picks the runtime at run time, from a user's choice or its own
configuration, so its code cannot know which runtime it holds. Runtimes
differ: cursor takes no environment for its tools, kimi and opencode resume
a session only in the directory it was created in, cursor, kimi,
antigravity, opencode v2 and Pi Durable take no system prompt, and kimi,
antigravity and opencode v2 cannot steer. The design question is how a host
learns what it may ask for, and what happens when it asks for more.

**The position: a host never gets something other than it asked for, never
parses prose to learn why, and never names a runtime to decide.** Three
tools, each used only where the one before does not fit.

## 1. A whole operation is a member that may be absent

When a runtime either can or cannot do a whole thing, the thing is an
optional member and its presence is the capability. `Runtime.accountUsage`,
`listModels`, `installPlan`, `install`, `checkUpdate`, `upgrade`, `login`,
`logout` and `authStatus` already work this way (antigravity, whose terms
rule out a sign-in through OAR, has no `login`, only the runtimes OAR signs
in have a `logout`, and bundled pi and cursor have no `install`);
`Session` `steer`, `withdraw` and `resources` do too: a session that cannot
steer has no `steer`, one whose queue OAR does not hold (codex) has no
`withdraw`, and one whose runtime runs in the host process (pi, cursor) has
no `resources`.
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

## 3. A declaration only where a host must decide before acting

Some decisions come before any call: rowrow passes `env` to every session
and must leave it out for a runtime that refuses it; a UI shows an attach
button only where images go. For those, the runtime declares the fact up
front:

- `Runtime.refusedSessionOptions`: the options a runtime refuses at open,
  each with its reason.
- `Runtime.installLines`: the parallel release lines a runtime installs
  (opencode `v1`, `v2`), so a host offers the choice OAR does not make
  before it plans an install; `install` answers `line_required` from the
  same list.
- `Session.capabilities`: per-session facts that are not operations
  (`images`, the `attribution` tier, whether held input is `durable`), some
  known only after the runtime's handshake.

A declaration is added for a real pre-action need, not mirrored for every
option. It is the same data the refusal reads: one shared check rejects a
declared option before anything starts, so the declaration and the behavior
cannot drift, and a test opens every declared refusal against the registry.

## A form for choosing settings

A host that lets a person set up an agent asks every runtime the same
question: which settings it takes, which values each may have, and how the
chosen values become `SessionOptions`. The runtime that owns a setting
answers, as plain data: `configForms` in `@botiverse/oar/forms` (Grok so
far), with `validateConfig` and `toSessionOptions` as pure functions beside
it. The entry loads no runtime SDK, so a server or a browser can render the
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
  never drops one: `toSessionOptions` names a field it cannot map, and
  `session()` refuses a value the runtime no longer accepts.

How a host stores a configuration stays the host's. Contract:
[config form](../spec/config-form.md).

## A runtime's own settings

A setting only one runtime has is never a field of the shared contracts.
Where it goes depends on how long it holds:

- **For the host's lifetime** (where an SDK loads from, an executable path,
  a data directory): an argument of that runtime's own constructor,
  `createXxxRuntime(options)`, typed by that runtime alone. Constructors
  share no shape. Two have one today, because each needs something only
  the host has: cursor its SDK, a package the host installs
  (`createCursorRuntime({ sdk: () => import("@cursor/sdk") })`), and Pi
  Durable the host's open Harness and Models
  (`createPiDurableRuntime({ harness, models })`).
  A runtime gets a constructor when it first needs one; for a built-in
  runtime, calling it without arguments gives the built-in one. The process environment
  knobs `OAR_CODEX_BIN`, `OAR_CODEX_SANDBOX` and `OAR_PI_AGENT_DIR` are
  settings of this kind; they move into constructors when a host first needs
  them per instance.
- **For one session** (a native feature switch for one agent): with the
  session, keyed by the runtime it is for (`SessionOptions.native.codex`),
  so a host still sends one set of options to every runtime. Not built until
  a real need arrives; it becomes a shared `SessionOptions` field once a
  second runtime has the same concept.

A package the host installs is handed over, never looked up. Written in the
host's own code, `import("@cursor/sdk")` fails the host's compile when the
package is missing (`skipLibCheck` cannot hide it), checks the SDK's types
against what OAR uses, and is visible to a bundler; a lookup inside OAR
would fail only at run time. `defaultRuntimes` holds what OAR
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
  image support comes from `initialize`, so it lives on the session.
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
