# Orientation

`orient(registry, options?)` runs a registry's existing readers under one
time budget and returns what each one said. It never calls
`Runtime.session`, submits a prompt, installs software or starts a login;
a native model reader can still open a session of its own (see the depth
table). It has no runtime-name branches. The types are in
`contracts/orientation.ts`, the behavior in `shared/orientation/` and
`tests/orientation.test.ts`.

```ts
import { defaultRuntimes, orient } from "@botiverse/oar";

const facts = await orient(defaultRuntimes, { runtimes: ["claude", "codex"], depth: "account" });
```

## Adapter version requirements

`Runtime.minVersion` is the oldest native version the adapter supports. It
is not an upgrade action, and newer builds can still lack a capability.
Each reader checks the floor for the path it actually uses, even when the
caller never called `installation()`; a version that is too old or
unreadable never starts the unsupported query. The refusal keeps each
reader's usual result kind and adds `installedVersion` and
`requiredVersion` where they are known. A direct auth reader can return an `unknown` status. When the installation
itself is unsupported, orientation reports an `unsupported` auth probe and
makes no inference about account state.

## Environment

Every reader takes `env` with the meaning of `SessionOptions.env`: a string
overrides an inherited value and `null` removes it. The host's `process.env`
is never changed and no shell profile is loaded; call
[`userShellEnvironment()`](login.md#explicit-login-shell-environment) and
pass its `env` everywhere when a login shell is wanted. Executables are
resolved from that environment on every call. An empty PATH never searches
the working directory; an unset PATH searches `/usr/bin:/bin` on POSIX and
nothing on Windows.

A runtime that refuses `env` for sessions (`refusedSessionOptions.env`)
refuses it for its readers too. `orient` reads such a runtime with the host
environment, since that is what its sessions get. Where a reader accepts
`env` only in part, its runtime page says how.

## Depth and effects

| Depth | Reads | What it can do |
| --- | --- | --- |
| `local` (default) | installation, auth status declared `localOnly`, stored provider metadata | Start a native version command. No network, credential refresh or key command. |
| `account` | plus every auth status, resolved providers, account usage | Contact services, run configured key commands, refresh credentials in the native store. |
| `models` | plus model listing | Start native processes or sessions without a prompt, load user and project code, connect MCP servers. |

An auth reader not declared `localOnly` is skipped at `local` depth.
Model listing runs in the host's current directory, so call `models` only
from a workspace whose configuration you trust, or call `listModels` with a
`cwd`. Costs beyond these, such as an extra process at installation
discovery, are on each runtime's page.

A `not_found` installation skips dependent readers. When the installation
probe fails or times out, its outcome propagates to the readers it blocked.
Absent reader methods remain `unsupported`. A native
`logged_out` skips usage and models; `unknown` does not. A reader that
throws is `failed` with a generic reason (`unsupported` when it refuses
`env`), so credential-bearing error text never reaches the snapshot, and
the other probes continue.

## Bounds and cancellation

The default overall budget is 60 seconds, with smaller caps per runtime and
per probe. Aborting `signal` rejects the call and stops queued reads from
starting. It does not undo a credential refresh, and it does not stop a
reader already running: a reader that ignores its deadline can outlive the
snapshot. Separate `orient` calls do not share budgets or concurrency;
hosts own scheduling across calls.

## Optional customization counts

`include: ["customization"]` runs the native skill, command, MCP and tool
inventories in an empty temporary directory, at any depth. That directory
keeps project content out; it does not sandbox the user's configuration.
These reads can execute user code, start the runtime, connect MCP servers
and reach the network, so `local` depth's no-network promise does not cover
them. If any inventory times out, the whole probe is `timed_out`; if any
fails, is unavailable or is partial, the whole probe is `failed`. Among
complete catalogs, a category whose entries' provenance is not all known,
or that only reflects context or MCP servers, is left out rather than
guessed; a complete empty catalog counts zero.

## Session capabilities

For an available installation, each runtime's entry also has
`sessionCapabilities`: what a session from that installation will offer
(steer, images, the options it refuses, manual compaction, compaction
events), with the static declarations merged in
([runtime matrix](runtime-matrix.md#session-capabilities-before-open)). It is
pure, so it is a value, not a probe. Every entry, installed or not, also
carries the runtime's `verifiedPlatforms` and `credentials` shape
([platforms and credentials](runtime-matrix.md#platforms-and-credentials)). Together with `brand`, the
installation snapshot and the probes, the whole report is plain JSON: a host
can send it from the machine to a server unchanged and key it by runtime and
installed version.

## Readiness is host policy

`orient()` reports facts and missing evidence. It does not say whether a
runtime is usable or pick one. A configured key is not proof it works, and
absent evidence is not a logout. A result describes the account selected by
that call's environment, not every account using the runtime, so a host
that pauses work on `rate_limited` scopes that to the runtime and its own
account key ([account scope](account-usage.md#environment)).

## CLI and verification

The CLI has no orientation command. `oar installation`,
`oar account status`, `oar account usage` and `oar models` read one surface
each, with the CLI process's environment. To read another account, set that
runtime's variable for the child process, for example
`KIMI_CODE_HOME=/home/b oar account usage kimi` (in PowerShell, set
`$env:KIMI_CODE_HOME` before running and restore it after). The
[Kimi account probe](../../experiments/orientation/kimi-accounts.md) and
the [native cost probe](../../experiments/orientation/README.md) are the
measured evidence.
