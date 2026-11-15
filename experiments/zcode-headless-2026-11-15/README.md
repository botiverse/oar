# ZCode headless and app-server comparison

November 15, 2026. **app-server is the stronger control interface.** Headless is
an option for a deliberately smaller first adapter when reusing the official
login is the deciding requirement. It loses steering and interactive decisions,
and needs a process per prompt. Choose app-server for an API-key-first adapter;
do not implement an unofficial subscription credential bridge in OAR.

This is a recommendation for review, not an adapter implementation or a claim
that official subscription login has been tested.

## Version and method

The probe ran the Linux x64 Node bundle built from upstream commit
[`fec975905a2abd4c07e35c40d51fa097a2258ec9`](https://github.com/zai-org/ZCode/tree/fec975905a2abd4c07e35c40d51fa097a2258ec9),
whose package version is **3.18.2**, on Node **24.19.0**. The requested 3.17.2
was still the latest GitHub release when checked. These findings apply to this
source build, not an untested 3.17.2 executable or a packaged 3.18.2 release.
Install scripts were skipped, then the CLI and its dependencies were built;
this is sufficient for these exercised paths, not validation of the full distribution.

Every model response came from a loopback OpenAI-compatible fixture with a
synthetic key. HOME, USERPROFILE, data, cache, storage and logs were disposable.
No existing credential was read, copied or exchanged; no paid model ran.
Standalone startup did report a built-in provider catalog refresh from the
CDN, so this was not an entirely offline experiment.

[Selected evidence](evidence.json) contains the frames cited below, with local
paths replaced. Full requests, prompts, logs and earlier probe attempts stay
local; their fingerprints are in [the manifest](manifest.json).

## Authentication: the important difference

**A custom API key works in app-server.** Both entrances load the personal
provider file. This probe used `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, an
`access: { type: "api-key", apiKey: ... }` provider and a loopback `api.baseUrl`.
The key was read by ZCode itself. The file can be managed by the user; OAR does
not need to extract it. This is an API-key path, not evidence that a website
subscription supplies the same kind of key. The documented config does not
promise `${ENV}` expansion; old `ZCODE_API_KEY` and `ZCODE_MODEL` variables are
not generic overrides. See [config documentation, lines 13-77](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/docs/usage/03-config.md#L13).

**Official subscription authentication belongs to the host in app-server.**
The protocol entry point calls the provider runtime without the `standalone`
option ([entrypoint:205](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts#L205)).
Only the standalone branch constructs the shared credential reader and account
service ([provider runtime:55-117](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts#L55)).
The official host sends `provider/updateAccountConfig` and responds to
`interaction/requestProviderRuntimeHeaders` with per-request authentication
([protocol:2656](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/zcode-protocol/index.ts#L2656),
[protocol:2910-2981](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/zcode-protocol/index.ts#L2910),
[official host:3205 and 6547](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/services/src/zcode-agent/zcodeAgentService.ts#L3205)).
A personal-provider path selects a different file format; pointing it at
`credentials.json` does not enable this account service.

**There is no separate app-server login in the inspected CLI.** The documented
`zcode login [zai|bigmodel] [--no-browser]` writes the native shared login store.
`app-server` and `agent-server` dispatch to the same protocol entrance;
`login` is a separate command ([dispatch:608-625](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/cli/src/run.ts#L608)).
Repeating login does not make that entrance instantiate a credential reader.
The official desktop host can use its existing account; no extra user login is
inherently required there. An independent OAR app-server client still lacks the
host's account/authentication service. No supported switch or credential-file
path was found that makes the worker own official login directly. This is a
source conclusion, not an authenticated subscription experiment.

Headless `-p` explicitly enables standalone account handling
([prompt entry:224](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/cli/src/prompt-command.ts#L224)).
Its native credential path is derived from the data base directory, then
`.zcode/v2/credentials.json` ([credential store:389-398](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L389)).
OAR should let ZCode perform this work, including any OS credential-store use.

## Observed behavior and headless costs

| Capability | Headless `-p --output-format stream-json` | app-server comparison |
| --- | --- | --- |
| Stream | Text and reasoning deltas, native session/trace/turn IDs and sequence numbers, tool schedule/start/result/batch, terminal turn event and final result. Tested normal and tool turns; not proof of every native event class. | `session/event` delivered the tested turn and tool lifecycle. Desktop delivery may omit tool input from one event and reference model streaming instead. |
| Resume | A new process with `--resume` kept the session ID and sent the prior prompt and assistant response in the next model request. | Persistent sessions can receive subsequent inputs in the same process. Cold app-server resume was not tested. |
| Steering | Stdin written during a held model request produced no new input or request. `-p` exposes no live-input protocol. | Busy legacy `session/send` returned `-32010`. V4 `sendText` with `requestedDelivery: guide` was accepted; its acknowledgement said `queue`, then `turn.steerQueued` and `turn.steerDrained` occurred in the active turn. The next model request contained the marker and that same turn completed. Do not mistake this acknowledgement for a separate queued turn. |
| Interactive decisions | `AskUserQuestion` emitted a request then a denial: no permission client configured. There is no opportunity for the host to answer mid-run. A plan-mode write was denied and did not create the file. Both tool refusals still ended with a successful model turn and exit 0. | Protocol has reverse requests and response methods; an interactive approval round trip was not exercised. |
| Cancellation | SIGTERM during a held model request emitted `turn.completed` with `resultType: cancelled`, exited 143 and emitted no final `result`. The process ends; later work needs another invocation. | `session/stop` emitted a cancelled turn while keeping the worker available; another session was then created successfully. |
| Process model | One requested session/prompt per process. Sequential resumes require relaunch, and concurrent sessions need separate processes. | Two distinct sessions were created and listed in one worker. Concurrent model execution and shared failure isolation were not tested. |
| Usage | The supplied 13 input / 7 output tokens appeared unchanged in a one-request result; two-request tool turns aggregated to 26 / 14. These are synthetic counters, not billing measurements. | Tested successful turn events carry the same usage shape. |
| Model / effort | `turn.started.payload.intent.modelSelection` reported the selected provider/model and `reasoningLevel: enabled`. This is execution-time read-back, not confirmation before opening. No `--model` or effort flag. | Create/send accept explicit model selection; a missing reasoning level caused a structured `invalid_model_request`. The working client supplied it on both create and send. |

The stream and result implementation is in
[prompt-command.ts:315-402](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/cli/src/prompt-command.ts#L315).
The headless permission broker defaults to denial but has explicit workflow
exceptions; do not generalize this probe to every tool or workflow
([headless-workflow.ts:20-60](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/cli/src/headless-workflow.ts#L20)).
V4 inputs are declared in
[command.ts:142-206](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/zcode-protocol-v4/command.ts#L142).
Linux cancellation here does not establish Windows behavior or descendant cleanup.

## Configuration isolation is an additional cost

There is no headless per-session MCP argument. Two sequential invocations with
changed disposable user MCP config called the same server name and returned
`mcp_a:MCP_PROBE` then `mcp_b:MCP_PROBE`. This proves startup reload, not concurrent
isolation. app-server's create schema has per-session `mcpServers`, but that
path's isolation was not tested ([schema:2024-2044](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/zcode-protocol/index.ts#L2024)).

For a headless adapter, a possible design is a separate HOME/USERPROFILE for
runtime config and an explicit personal-provider file for model selection,
plus a persistent per-session storage directory. Native user MCP config reads
HOME, while native login uses the data base directory
([file loader:62-85](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L62)).
Keeping that data base directory at the user's native login location could
preserve native authentication without OAR copying credentials. **That mixed
layout and its OS keyring behavior have not been tested.** The fully isolated
layout used here intentionally had no real login. Do not promise simultaneous
login reuse, arbitrary per-session model overrides and MCP isolation yet.

Until that boundary is verified, inherit native settings or refuse unsupported
session options instead of editing a shared user file. User MCP entries can
also override project entries, so a project-local file alone is not proof of
isolation. Model selection likewise belongs in the native provider configuration;
a per-session override must not rewrite the user's default or copy credential
material to implement it.

## Reproduce and retained limitations

Build the pinned upstream checkout, then run from the OAR repository:

```sh
node experiments/zcode-headless-2026-11-15/probe.mjs /absolute/path/to/zcode.cjs /tmp/zcode-probe-output
```

The probe needs Node 24+, Linux shell tools and the adjacent `echo.mjs` fixture.
It writes private raw captures and leaves its disposable directories for
inspection. `PROBE_CASES=app` runs only the app-server control. It is not a CI
model test. Normal cases have a 30-second process bound; protocol operations
have a 15-second observation bound.

The final ten-scenario run passed its assertions. OAR's full local check also
passed: 4,281 tests and 18 mock behavior cases. Earlier preparation attempts
are retained: an omitted runtime-preference response, incomplete model
selection on create/send, a wrong tool-event predicate, and an assertion that
mistook previously stored sessions for extra app-server sessions. Those are
probe setup errors, not evidence of native instability. The first plan control
used a permitted read-only command; the later write-denial control establishes
the intended boundary. Raw attempt identities and hashes remain in the manifest.

No real subscription, official packaged binary, Windows/macOS, image input,
concurrent MCP isolation, descendant cleanup or full V4 contract was validated.
No OAR adapter or production capability declaration changes in this experiment.
