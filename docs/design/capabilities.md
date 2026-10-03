# Capabilities

A host picks the runtime at run time, from a user's choice or its own
configuration, so its code cannot know which runtime it holds. Runtimes
differ: cursor takes no environment for its tools, kimi resumes a session
only in the directory it was created in, kimi and antigravity take no system
prompt, three runtimes cannot steer. The design question is how a host learns
what it may ask for, and what happens when it asks for more.

**The position: a host never gets something other than it asked for, never
parses prose to learn why, and never names a runtime to decide.** Three
tools, each used only where the one before does not fit.

## 1. A whole operation is a member that may be absent

When a runtime either can or cannot do a whole thing, the thing is an
optional member and its presence is the capability. `Runtime.accountUsage`,
`listModels`, `checkUpdate` and `upgrade` already work this way; `Session`
`steer` and `queue` do too: a session that cannot steer has no `steer`.
TypeScript makes every caller handle the absence, and the check works the
same for a runtime chosen at run time: it reads the member, not a name.

No flag sits beside such a member. A flag could disagree with the member; the
member cannot disagree with itself.

## 2. An option nobody can drop is refused with a typed error

`session()` exists on every runtime, so what differs is its options. An
option a runtime cannot honor makes `session()` reject with
`UnsupportedOptionError` (`runtime`, `option`, and the reason as its
message), never a session that quietly runs without it. A host may simply
try and fall back on that error; it needs no list to do so.

The error says which option, so a host can tell "not this runtime" from a
failed login or a network error without reading the message. Where the
runtime's own word decides (kimi's directory comes from its `session/list`),
the adapter throws the same error.

## 3. A declaration only where a host must decide before acting

Some decisions come before any call: rowrow passes `env` to every session
and must leave it out for a runtime that refuses it; a UI shows an attach
button only where images go. For those, the runtime declares the fact up
front:

- `Runtime.refusedSessionOptions`: the options a runtime refuses at open,
  each with its reason.
- `Session.capabilities`: per-session facts that are not operations
  (`images`, the `attribution` tier, whether held input is `durable`), some
  known only after the runtime's handshake.

A declaration is added for a real pre-action need, not mirrored for every
option. It is the same data the refusal reads: one shared check rejects a
declared option before anything starts, so the declaration and the behavior
cannot drift, and a test opens every declared refusal against the registry.

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
(`session.steer === undefined`, an in-process `bundled` installation for
the kill case), never by runtime name.

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
