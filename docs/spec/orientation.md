# Orientation

`orient(registry, options?)` combines a registry's existing readers into one
bounded snapshot. It does not call `Runtime.session`, submit a prompt, install
software or start a login flow. Native readers still own their discovery,
credential resolution and model catalogs. The aggregate has no runtime-name
branches. Hosts interpret the snapshot and own readiness and selection policy.

```ts
import { defaultRuntimes, orient } from "@botiverse/oar";

const facts = await orient(defaultRuntimes, {
  runtimes: ["claude", "codex", "pi"],
  depth: "account",
  timeoutMs: 60_000,
});
```

## Adapter version requirements

`Runtime.minVersion?: string` declares an existing minimum native version
for the adapter. It is metadata, not an upgrade action or a promise that
all newer builds support every capability. Omission means no adapter-wide
numeric floor is declared. Feature-specific requirements, such as login,
remain on that feature's refusal.

The declared floors are Antigravity stable `1.5.0`, DSH `0.2.1-rc.5` and
Pi subprocess explicit commands `1.4.0`. Readers check the requirement for
the path they actually use, without assuming the caller first invoked
`installation()`. For a machine executable whose installation has no
version, a bounded `--version` query precedes the actual reader. An old or
unreadable version never starts that unsupported query.

Version refusals preserve the existing result kinds and human-readable
explanations. Optional `installedVersion` and `requiredVersion` carry the
observed version, when readable, and the required version. Model listing
and installation use `unsupported` with optional `code: "version_unsupported"`;
inventory uses the same code on `unsupported`. Account usage uses
`unsupported.reason: "version_unsupported"`. Authentication status remains
`unknown`, with optional `code: "version_unsupported"`, because an unsupported
CLI says nothing about whether its account is signed in.

Pi's floor only applies when the reader starts a native RPC command. A
subprocess runtime can still read through the bundled SDK when the environment
is unchanged; the custom command's version does not govern that SDK path.
The default RPC entry must exactly match OAR's bundled Pi, so its refusal
reports that exact version as `requiredVersion`. See
[Pi reader environments](../runtimes/pi.md#reader-environment).

## Environment

`OrientOptions.env` observes the environment a session can use. For each
runtime, `orient` checks its `refusedSessionOptions.env` declaration. When
present, `orient` omits the overlay from that runtime's readers and observes
the host environment; it does not mark the runtime unsupported. Otherwise it
passes the overlay to every reader selected by depth and includes: installation,
auth status, providers, usage, models and inventories. This decision uses the
declaration, never the runtime name.

It uses the same overlay as `SessionOptions.env`: a string overrides an
inherited value and `null` removes it. Omission or `{}` uses the host environment.
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
never searches the working directory for a bare command. An unset PATH searches
`/usr/bin:/bin` on POSIX; on Windows an unset or empty PATH finds no bare command.
Explicit paths and supported installation fallbacks remain usable.

CLI readers pass that environment to their native processes. Cursor (in its
default in-process mode), Pi Durable and community Morph direct readers
reject nonempty overlays with `UnsupportedOptionError("env")`, matching their
session refusals; Cursor's subprocess mode passes the overlay to the
one-shot child each reader starts. `orient`
therefore calls those readers without an overlay and preserves their host facts.

Pi's in-process readers accept the overlay with their session's meaning: the
inventory session's Bash tool receives it, while SDK configuration, credential
resolution and SDK-owned key commands use the host environment. With
`execution: "subprocess"`, model, skill and command readers keep the host SDK
path (richer metadata and loading diagnostics, no RPC process) when the overlay
makes no actual change. Actual
changes use bounded native RPC processes with the session's full environment
and startup policy. Pi RPC has no tools/providers query: those readers still
use the host SDK, and reject actual environment changes with
`UnsupportedOptionError("env")` before loading it. Equal values and removal of absent variables are accepted. Bundled
installation discovery is independent of the overlay in both modes.
RPC inventories have `partial:true` because loading diagnostics are absent;
SDK inventories retain their native completeness result. RPC model-query
failures reject and become `failed` or `timed_out`, rather than `unsupported`.
See [Pi's coverage and missing metadata](../runtimes/pi.md#reader-environment).

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

CodeBuddy installation discovery first checks its override, PATH and ordinary
fallback location. If it finds nothing and npm exists, each probe starts a
local `npm prefix -g` query with a 15-second limit to discover the configured
global bin directory. The query uses and then removes a private temporary
cache, leaving HOME and Node's installation unchanged. A failed or timed-out
query returns the original `not_found`; a missing npm skips the query. This
extra process cost applies even at `local` depth on hosts without CodeBuddy.

An auth reader without an evidenced `localOnly` declaration is skipped at
`local` depth with `{ kind: "skipped", because: "depth" }`. An absent reader
is `unsupported`. Cursor and Qwen declare local auth status; Antigravity,
Claude, Codex, CodeBuddy, Devin, Factory, Grok, Kimi and Qoder require
`account` depth. DSH, OpenCode, Pi and Pi Durable expose no auth reader. No direct credential-file
parser is added for the aggregate.

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

[`LoginAccount.credential` and `metering`](login.md#status-results) are
independent, optional native facts. Claude `claude.ai` and Codex `chatgpt` map
to account/plan; their generic API keys leave
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

## Readiness is host policy

`orient()` preserves each probe's facts and missing evidence. It does not
classify a runtime as usable or choose one for the host. Hosts decide which
probes are required, how old a snapshot may be, and how installation, account,
version and quota observations affect scheduling. A configured provider is
not proof that its credentials work, and absent evidence is not a logout.

A verdict describes the account selected by that observation's environment,
not every account using the runtime. Hosts that suspend work for `rate_limited`
must scope that decision to the runtime and the selected account, retaining
their own account/configuration key alongside the snapshot
([account scope](account-usage.md#environment)). Absent native identity does
not justify applying one account's limit to the others.

## CLI and verification

The CLI has no orientation command: `orient()` is for hosts that want one
bounded snapshot. On a terminal, `oar installation`, `oar account status`,
`oar account usage` and `oar models` read the same facts one surface at a time.

The CLI inherits its process environment. A separate environment flag is not
required to select another Kimi account:

```sh
KIMI_CODE_HOME=/home/b oar account usage kimi
KIMI_CODE_HOME=/home/b oar account status kimi
```

In PowerShell, set the process variable before starting the commands, then restore
its previous value:

```powershell
$previousKimiHome = $env:KIMI_CODE_HOME
try {
  $env:KIMI_CODE_HOME = 'C:\accounts\b'
  oar account usage kimi
  oar account status kimi
} finally {
  $env:KIMI_CODE_HOME = $previousKimiHome
}
```

PowerShell's [environment variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables)
are inherited by child processes. A host spawning the CLI directly supplies the
same variable in that child's environment. Match the probe environment to the
session's account configuration; an unqualified probe observes its own inherited
configuration, not an arbitrary agent's account.

The [Kimi account probe](../../experiments/orientation/kimi-accounts.md) verifies
both commands, including the orientation readiness table, with real Kimi 2.4.1
and two isolated synthetic accounts on Linux. It does not establish Windows
runtime behavior.

`tests/orientation.test.ts` covers depth, absence, independent failures, budgets,
slots, cancellation, and truthful inventory counts.
`tests/providers/provider-local.test.ts`
uses the real Pi SDK with an expired OAuth entry and a key-command sentinel.
The [native cost probe](../../experiments/orientation/README.md) runs the built
CLI against isolated synthetic stores and records attempted network access.

## Model effort discovery

`ModelEntry.effortLevels` is the runtime's menu for that particular model;
`defaultEffort` is present only when the runtime reports its default.
`effortUnavailableReason?: string` explains when this query could not determine
a model's menu. It is a short adapter explanation, never raw native error text,
and is mutually exclusive with `effortLevels` and `defaultEffort`. It does not
mean the model is disabled. When a runtime has no effort facility, all three
fields are absent. Hosts must distinguish that absence from a failed menu read
and must not copy another model's menu to fill a gap.
