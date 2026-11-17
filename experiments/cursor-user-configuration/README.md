# Cursor SDK configuration sources

## Default settings: SDK 1.4.0, 2026-11-17

OAR now explicitly selects `["project", "user"]` for default/include
sessions and `[]` for exclusion. Previously the omitted SDK option selected
no settings. This is a behavior change: default sessions now run configured
hooks and connect configured MCP servers. Hosts wanting exclusion must pass
`userConfiguration: "exclude"`.

Run `pnpm tsx experiments/cursor-user-configuration/probe.ts` in a separate
process. It loads the **unmodified** pinned SDK, creates an isolated home and
project as sibling directories, writes a synthetic SDK credential and
conflicting CLI model preferences, permits TCP only to its local backend,
and deletes its fixtures afterward. Inference is deliberately rejected;
there is no real login, remote inference or external connection. Hooks write
local marker files and both MCP fixtures implement the native protocol.

Linux x64, Node 24.19.0, SDK 1.4.0: all six controls passed.
[Selected results](settings-1.4.0.json) contain each assertion's observation;
[manifest](settings-1.4.0-manifest.json) identifies retained raw logs and the
published SDK bundle used for source inspection.

| Open | User/project skills read | Project rule and AGENTS read | User/project hooks execute | User/project MCP connects |
|---|---|---|---|---|
| OAR default | both | yes | both | both |
| OAR include | both | yes | both | both |
| Native settingSources omitted | neither | no | neither | neither |
| Native user-only control | user only | no | user only | user only |
| OAR exclude | neither | no | neither | neither |
| OAR exclude after reopen | neither | no | neither | neither |

Home `.cursor/rules` and `AGENTS.md` fixtures are not read in any control.
That is a measured fixture boundary, not a claim about every possible user
rule source. An initial fixture put the project underneath HOME, causing
ancestor rule discovery to read the home rules too. Moving home and project
to siblings removed this confounder; the initial failure is retained in the
manifest. The product mapping did not change in response to that failure.

Both scopes contain `.cursor/cli-config.json` with a conflicting model. The
SDK never reads those files, and `agent.model` retains the explicit
`gpt-5.4-nano` selection in all controls. The model catalog is a synthetic
local catalog, and no model generates an answer. OAR continues to supply
its existing Auto/fresh or latest-run/resume selection explicitly. Both
sandbox settings remain overridden by OAR's `enabled: false`. Stored-key
exchange and authenticated requests to the local run endpoint succeed; the
backend intentionally rejects the run, and login bytes remain unchanged.

Source inspected in `@cursor/sdk@1.4.0`:

- `dist/esm/993.js`, `sj`: omitted or empty settingSources resolves to all
  flags false; `aj` enumerates project/user/team/mdm/plugins.
- The local workspace builder selects MCP, hooks and local extensibility
  adapters from these flags. `jM` loads project/user `mcp.json`, `oN` creates
  the hooks runtime, and `cN` constructs native rule and skill services.
- `dist/esm/options.d.ts` types `local.settingSources`; OAR supplies model and
  sandbox options separately in `runtimes/cursor/model.ts`.

A preliminary read-only observation copy of the bundle exposed loaded
skills/rules and configured MCP clients; it was useful for discovery but is
**not** the six-control validation above. No copied or instrumented SDK is
used by OAR or by the committed probe. Skill inventory and native-loader
parity are a separate follow-up after this configuration fix lands.

## Earlier exclusion evidence

The earlier version of `probe.ts` ran with the pinned
`@cursor/sdk` installed. The executable probe sets a temporary HOME before
loading the SDK, writes a synthetic SDK login, restricts TCP connections to
its local backend, and removes its files afterward. Run it as a separate
process because it observes native filesystem calls and sets process-wide
environment variables. No real account or model inference is used.

Observed on Linux, SDK 1.0.40 on 2026-10-23; all four controls passed
again with SDK 1.1.0 on 2026-10-27 and SDK 1.2.0 on 2026-10-28:

| Open | User skill, hook and MCP files read | User MCP connects | Original stored login used |
|---|---|---|---|
| OAR default | no | no | yes |
| Native SDK `local.settingSources: ["user"]` positive control | yes | yes | yes |
| OAR `userConfiguration: "exclude"` | no | no | yes |
| Another OAR exclusion open after disposal | no | no | yes |

The SDK also reports one user rule and skill in the positive control. The
observer records actual native reads without changing their results.
SDK 1.2.0's bundled text decoder opens a `FileHandle` and calls its
`readFile`; 1.1.0 used `fs.promises.readFile`. The old observer therefore
missed the positive control's skill read even though the SDK reported
loading it. The initial failure, unchanged recheck and diagnostic failure
are retained. Adding observation of `FileHandle.readFile` made all four
original controls pass; no assertion, deadline or adapter behavior changed.
See the [daily report](../runtime-version-checks/2026-10-28.md#configuration-observer).
Every open exchanges the synthetic stored key and reaches the local run
endpoint with the returned access token. That endpoint intentionally rejects
inference, and the probe asserts the terminal error. The login file remains
byte-for-byte unchanged and native `auth.status()` still reports logged in
after disposal and reopen. SDK keys are static; no refresh flow is claimed.

OAR passes `sandboxOptions.enabled: false`: native SDK code still reads the
user sandbox file, but the explicit option takes precedence. Default and
exclusion opens do not select project settings either. This evidence covers
local configuration selection, not successful model generation or
server-side account rules and memories. Managed organization policy remains
native.

The SDK's `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` is used only by this probe to
avoid an external model-catalog request. It is not an OAR option. The normal
SDK transport retry behavior is retained, so the four deliberate inference
errors can take about a minute.
