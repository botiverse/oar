# Orientation

`orient(registry, options?)` combines a registry's existing readers into one
bounded snapshot. It does not call `Runtime.session`, submit a prompt, install
software or start a login flow. Native readers still own their discovery,
credential resolution and model catalogs. The aggregate has no runtime-name
branches. `usability(snapshot, options?)`, from `@botiverse/oar/observe`, is a
separate pure projection that also runs in a browser.

```ts
import { defaultRuntimes, orient } from "@botiverse/oar";
import { usability } from "@botiverse/oar/observe";

const facts = await orient(defaultRuntimes, {
  runtimes: ["claude", "codex", "pi"],
  depth: "account",
  timeoutMs: 60_000,
});
const choices = usability(facts, { minVersions: { codex: "0.164.0" } });
```

## Environment

`OrientOptions.env` observes the environment a session can use. For each
runtime, `orient` checks its `refusedSessionOptions.env` declaration. When
present, `orient` omits the overlay from that runtime's readers and observes
the host environment; it does not mark the runtime unsupported. Otherwise it
passes the overlay to every reader selected by depth and includes: installation,
auth status, providers, usage, models and inventories. This decision uses the
declaration, never the runtime name.

It uses the same overlay as `SessionOptions.env`: a string overrides an
inherited value and `null` removes it. Omission or `{}` keeps existing behavior.
The host's `process.env` is never mutated and shell profiles are never loaded
implicitly. To use a login shell, call
[`userShellEnvironment()`](login.md#explicit-login-shell-environment) explicitly
and pass its `env` to discovery, authentication, readers and sessions alike.

The individual readers accept `env` too: `installation({ env })`,
`authStatus(installation, { env })`, `accountUsage(installation, { env })`,
`listModels(installation, { env })`, the inventory methods and
`providers(installation, { env, resolve })`. Installation resolves binary
pins, PATH/PATHEXT, shadowed copies and home-based fallbacks from that environment
on each call, and uses it for readiness and version commands. An empty PATH
never searches the working directory for a bare command; explicit paths and
supported installation fallbacks remain usable.

CLI readers pass that environment to their native processes. Cursor and Pi
Durable direct readers reject nonempty overlays with
`UnsupportedOptionError("env")`, matching their session refusals. `orient`
therefore calls those readers without an overlay and preserves their host facts.

Pi readers accept the overlay with its in-process session meaning: the
inventory session's Bash tool receives it, while SDK configuration, credential
resolution and SDK-owned key commands use the host environment. Bundled
installation discovery is independent of the overlay. These readers remain in
the host process even when Pi sessions use `execution: "subprocess"`; no separate
query protocol or host-environment mutation is introduced.

Kimi usage supports credential and CLI environment changes but rejects actual
changes to a fixed list of host HTTP/TLS variables
([list and rationale](account-usage.md#environment)). Its sessions accept env,
so `orient` passes the overlay and preserves that reader's precise refusal.

`orient` maps `UnsupportedOptionError("env")` to `{ kind: "unsupported" }`,
not `failed`, without exposing exception text or environment values. Other
read failures keep their existing classification. Direct calls retain the
typed exception so the caller can inspect the unsupported option.

## Depth and effects

| Depth | Readers | Effects |
| --- | --- | --- |
| `local` (default) | `installation`, declared local `authStatus`, optional `providers` with `resolve: false` | Installation discovery can start a native version command and materialize its own local files. Auth readers must declare `localOnly: true`: no network, credential refresh or key commands. Provider listing returns stored metadata without resolving credentials. |
| `account` | Installation, all `authStatus` readers, resolved `providers`, `accountUsage` | Native status or usage queries can contact services, execute configured key commands and refresh credentials in the native store. |
| `models` | Everything at `account`, plus `listModels` | Can start native processes or inspection sessions, load user/project code, connect MCP servers and query remote catalogs. No model prompt is submitted. |

An auth reader without an evidenced `localOnly` declaration is skipped at
`local` depth with `{ kind: "skipped", because: "depth" }`. An absent reader
is `unsupported`. Currently only Cursor declares local auth status;
Claude, Codex and Qoder require `account` depth. Other built-in runtimes do not expose
an auth reader. No direct credential-file parser is added for the aggregate.

When `CURSOR_API_KEY` is present, Cursor reports `unknown`: sessions use that
environment key, while the SDK's status method only describes a stored login.
OAR neither validates the key nor attaches the unrelated stored identity.

Pi's optional `Runtime.providers` reader reuses its provider facade. At local
depth it reports `CredentialStore.list()` entries' stored type and the SDK's
provider subscription metadata. `configured: true` means present in that
store, not validated: expired OAuth records and key commands remain visible
without refreshing or executing them. Credentials supplied only through the
environment are absent from this list. `account` and `models` use the facade's
normal resolution, which may refresh OAuth or execute a key command. The
facade's direct `listProviders()` call retains that normal behavior; a caller
opts into metadata with `{ resolve: false }`.

Model listing uses each reader's default workspace, normally the host's current
directory. Only call `models` from a workspace whose configuration you trust.
For a different workspace, call `Runtime.listModels(installation, { cwd })`
directly. Each [runtime page](../runtimes/README.md) describes its listing costs.

## Shape and missing evidence

The normative types are `contracts/orientation.ts`. `Orientation` carries the
collection's completion time, selected depth, and runtimes in registry order
or the caller's first-occurrence ID order. Unknown IDs fail before probing;
duplicate IDs are read once. There is no cache, ranking or cross-machine state.

Each runtime contains its `id`, `brand`, `installation` and `auth` probes.
`providers` is present only when the runtime exposes it. `accountUsage` appears
at account/models depth, `models` only at models depth, and `customization`
only on explicit request. Every observation preserves the native result,
including its own `source` and timestamp where that reader supplies them.

| Probe | Meaning |
| --- | --- |
| `ok` | The reader answered; `value` retains the native result and `observedAt` is when this call completed. An auth result can still say `unknown`. |
| `failed` | The reader threw. The generic `reason` avoids exposing arbitrary credential-bearing exception text. Other probes continue. |
| `timed_out` | The probe, runtime or overall budget expired, with its observation time. |
| `skipped` | An existing reader was not called because of `not_installed`, `logged_out` or `depth`. |
| `unsupported` | No reader exists, or the reader cannot provide that observation in the requested environment. |

A missing installation skips dependent existing readers. A failed or timed-out
installation propagates that failure to its dependent probes. Explicit native
`logged_out` skips usage and models; an unknown status does not suppress those
independent sources. Native model `unauthenticated` becomes a logged-out skip,
not an empty model list. Native `unsupported` remains unsupported.

`LoginAccount.credential` describes `account` or `api_key`, while `metering`
describes `plan` or `usage`. They are independent, optional native facts. Claude
`claude.ai` and Codex `chatgpt` map to account/plan; their generic API keys leave
metering unknown. Cursor's stored SDK user key maps to api_key/plan. The native
`method`, plan, email and expiry remain available. Provider-auth records keep
their existing `method` and `subscription` fields. A locally configured key is
not evidence that a remote request will succeed.

## Bounds and cancellation

The overall default is 60 seconds, each runtime has at most 45 seconds, and
each probe has at most 30 seconds, always reduced by remaining outer budgets.
Native readers receive the remaining timeout when their contract supports it.
Model and inventory reads share two slots per `orient` call. A slot remains
occupied until its underlying reader settles, even if the snapshot has already
recorded a timeout; queued calls do not start after their budget expires.

Aborting `signal` rejects the operation and prevents queued reads from
starting. It does not undo a native credential refresh or forcibly stop an
arbitrary host-supplied reader. Existing readers own their native process
cleanup and deadlines. A reader that ignores its bound can continue after the
snapshot is returned; orientation does not promise to kill in-process SDK
work. Multiple `orient` calls have independent budgets and slots. Hosts own
cross-call scheduling and credential-operation coordination.

## Optional customization counts

`include: ["customization"]` runs the existing skills, commands, MCP and tool
inventories in a canonical empty temporary directory. This is an explicit
additional cost at any depth, including local: native inventories can execute
user code, start runtimes and connect MCP servers. The empty directory excludes
ordinary project content; it does not sandbox the user's configuration.

Only complete `discovered` or `registered` catalogs with explicit recognized
provenance produce counts. Entries whose native `source` is `user` are counted;
built-in, project and local entries are not. Unknown or missing source labels,
context-derived and MCP-only catalogs leave that category absent. Plugin
content is counted only when its catalog identifies it as user-owned. An
unsupported category is absent, never guessed to be zero. A failed, partial or
timed-out inventory makes the whole customization probe fail or time out.
An empty complete catalog yields zero; no countable categories is unsupported.
The temporary directory is removed after all readers using it settle, including
late readers after a snapshot timeout.

## Usability is host policy

`usability` preserves runtime order and returns `{ id, usable, because? }`.
Installation failure gives `probe_failed`, absence gives `not_installed`, and
an unmet host-supplied semantic version floor gives `version_unsupported`.
No floor is built in. An unreadable or unavailable version cannot prove a
floor was met.

Native rate limiting, reauthentication requirements and explicit logged-out
answers prevent readiness. Otherwise a logged-in auth answer or a configured
provider is sufficient; missing auth evidence gives `auth_unknown`, and failed
or timed-out auth/provider probes give `probe_failed`. Optional failed quota,
model or customization observations remain visible without inventing a logout.
This is conservative selection guidance over the supplied facts, not a remote
login test or quota guarantee. Hosts decide how old a snapshot may be and may
apply their own policy instead.

## CLI and verification

`oar orient [runtime...] --depth local|account|models --json` prints the complete
snapshot. Without JSON it prints a compact readiness table. `--customization`
opts into inventories, and `--timeout <ms>` changes the overall bound. The
command exits successfully when a snapshot was produced, including partial
failures; invalid arguments and a rejected overall call fail the command.

`tests/orientation.test.ts` covers depth, absence, independent failures, budgets,
slots, cancellation, and truthful inventory counts. `tests/usability.test.ts`
covers policy and version floors. `tests/providers/provider-local.test.ts`
uses the real Pi SDK with an expired OAuth entry and a key-command sentinel.
The [native cost probe](../../experiments/orientation/README.md) runs the built
CLI against isolated synthetic stores and records attempted network access.
