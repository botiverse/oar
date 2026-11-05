# Runtime version check: 2026-11-02

The adapter built from this probe is [`docs/runtimes/dsh.md`](../../docs/runtimes/dsh.md).
It uses a version floor plus the method inventory rather than the exact-version
policy recommended below; this page stays as found.

DSH can load a bridge shipped outside its profiles and expose its native agent
controls and events directly. The working bridge has **zero runtime imports
from DSH packages**. Both `@deepseek-ai/dsh` **0.2.1-rc.5** (npm `latest`) and
**0.2.2-alpha.2** passed the 17 checks below on a local Linux x64 host. This is
an experiment, not an OAR runtime or a shared-process admission decision.
The runs used Node 24.19.0 and Python 3.12.3.

A peer declaration alone did **not** make a package outside the profile able to
import `@deepseek-ai/dsh-agent` or `@deepseek-ai/dsh-llm`. Both imports failed
with `ERR_MODULE_NOT_FOUND` on both installations. The absolute-path plugin
itself loaded and received the running process's services. The working
[bridge](bridge/native.mjs) therefore uses injected context services and only
Node built-ins. Its sibling [load probe](bridge/load.mjs) deliberately attempts
the two failing imports. The package has its own [manifest](bridge/package.json)
and is neither installed nor linked into either DSH installation or profile.

## Reproduce and inspect

Install either exact package in a disposable prefix using Node 24.9+ and npm,
then run from the OAR repository. Python uses only its standard library; the
model provider is a local HTTP fixture. No account or paid endpoint is used.

```sh
npm install --prefix /tmp/dsh-probe-runtime @deepseek-ai/dsh@0.2.1-rc.5
python experiments/dsh-plugin/run.py \
  --runtime /tmp/dsh-probe-runtime/node_modules/@deepseek-ai/dsh \
  --output /tmp/dsh-probe-evidence
python experiments/dsh-plugin/select_evidence.py \
  /tmp/dsh-probe-evidence/evidence.json /tmp/dsh-probe-selected.json
node --check experiments/dsh-plugin/bridge/native.mjs
```

Repeat with `0.2.2-alpha.2` and fresh output/prefix directories. The runner
requires an absent output directory, creates isolated HOME/DSH_HOME, and leaves
its artifacts there. It launches `dsh --profile acp --patch <absolute file>`,
disables the `acp` protocol plugin, and inserts the external bridge. The profile
supplies the native core and its stdin shutdown behavior; **no ACP messages,
connections, or translations are used**. `release` and `oar_probe_echo` are
fixture-only controls, not proposed host capabilities.

The [RC selection](evidence/0.2.1-rc.5.json) and
[alpha selection](evidence/0.2.2-alpha.2.json) retain a complete native tool turn,
stream frames, turn outcomes, child lineage, cwd results, startup inventory and
filesystem changes. Each includes the source evidence file's SHA-256. The
selector can reproduce the selection from that file. It replaces local absolute
paths and encoded cwd directory keys, retaining other native payload fields.
The original local evidence includes every frame, provider request and stderr.

The runner checks the executing JavaScript, not a TypeScript source promise:
`@deepseek-ai/` must not occur anywhere in `bridge/native.mjs`. A future typed
source can use erased `import type`; its built JavaScript must pass the same
runtime-dependency check. These `.mjs` files run directly, without a build step.

## Observed behavior

| Check | RC | Alpha | Assertion |
|---|---|---|---|
| Actual capabilities | Pass | Pass | First bridge frame inventories injected factory/persistence methods; each opened agent reports its actual control/inbox methods. |
| Tool turn | Pass | Pass | Real DSH executes the local echo tool and ends its turn as `completed`. |
| Steer while tool runs | Pass | Pass | Input appears in `nextStep`, reaches the next model request, and the original turn remains turn 1. |
| Inject while tool runs | Pass | Pass | Same boundary and provider observation, through native `inject()`. |
| Queue and withdrawal | Pass | Pass | Two `nextTurn` entries; one is removed by message id; retained input completes turn 2; withdrawn input never reaches the provider. |
| Cancel | Pass | Pass | Native end is `aborted` with nested `{kind: "user"}`; pending lists clear and the queued input never reaches the provider. |
| Inject while idle | Pass | Pass | Stays idle with pending input and no request; a later prompt consumes it. |
| New-session tool cwd | Pass | Pass | Native `bash` executing `pwd` returns the session directory exactly, without a tool cwd override. |
| Native child | Pass | Pass | Actual `subagent` tool publishes matching start/end ids, a parent `subagent/catalog` edge, child stream frames and a completed child turn. |
| Session list | Pass | Pass | Native persistence lists the created session. |
| Durable event preservation | Pass | Pass | Every forwarded event of the tool turn equals the native persistence read, in order. |
| Stream vocabulary | Pass | Pass | Text, reasoning, partial tool-call arguments, usage and finish chunks observed. |
| Cross-process resume | Pass | Pass | A fresh process resumes the id; the next provider request contains both prior and new user input. |
| Resumed tool cwd | Pass | Pass | New process starts in another directory; native `pwd` still returns the saved session directory. |
| User configuration applies | Pass | Pass | Provider is configured only in the existing profile patch; the home patch's persona marker reaches the model. |
| No DSH runtime imports | Pass | Pass | Executing bridge JavaScript contains no DSH package references. |
| Existing configuration preserved | Pass | Pass | Profile file hashes and home patch bytes remain unchanged. |

The startup inventory and method presence do not prove every option's semantics.
There is a concrete ABI difference: RC's agent has no `model.current()`, while
alpha has it. Opening reports that difference before a prompt; calling the
experimental query on RC returns `native_method_unavailable` with its capability
and reason, rather than synthesizing a model value. Basic route selection still
works through `agentOptions` on both versions.

Native resume takes an id and has no cwd override in the observed factory API.
The saved cwd and actual tool execution agree. The probe does not silently pass
an unsupported cwd field or claim that DSH can migrate a session to another cwd.
Live queue behavior is covered; pending-input recovery after a crash is not.

## Filesystem and configuration boundary

The literal claim “nothing writes to DSH_HOME” is false. Cold startup creates
four profile files under `profiles/acp`: `package.json`, `pnpm-workspace.yaml`,
`cordis.yml`, and `cordis.patch.yml`. The runner's later user home patch is
recorded separately from initialization. The captured cold
change list is authoritative for each installation.

For an existing profile, the invocation overlay does not install the bridge,
rewrite the user's provider selection, or replace the home patch. Both existing
configuration contents remain unchanged and demonstrably apply. Native sessions
write compressed session logs, lock files and projection-cache files under
DSH_HOME. The warm diff records those additions. Content hashes establish
unchanged bytes, not that the launcher never opens a file for writing.

The effective order is bundle layers, profile patch, home patch, then invocation
patches. The provider test deliberately removes its temporary provider override
from the invocation layer before testing the existing user provider, so a later
override cannot conceal a broken user setting. Source:
[profile composition at ce7073d](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/cli/src/profile-boot.ts).

## Native information beyond DSH's ACP projection

The bridge forwards `session/event` payloads with their native `type`, `seq`,
`time`, `data` and optional provenance fields. It also forwards
`agent/assistant-stream` frames with attempt identity, revision, chunk index,
turn/step anchors and settlement reference. Durable `assistant/message` remains
separate from transient chunks, preventing either from being mistaken for a
second assistant message. The test compares forwarded durable records with
`sessionPersistence.open(id, "read").read()`.

DSH's current ACP bridge instead projects committed assistant messages, generic
tool starts/results and context occupancy. Its
[event handler](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/session.ts)
and [update conversion](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/updates.ts)
do not forward this full stream. Direct access retains live argument fragments,
stream attempt/settlement identity, native token usage, request headers/context,
inbox splice identities, step boundaries, cancellation cause, and durable child
catalog edges. Live child start/end notifications alone lack the parent id;
use the parent-owned `subagent/catalog` record for that relationship. This
comparison is source inspection, not a second ACP experiment.

## Dependencies, churn and version policy

The bridge depends on Cordis context/loader lifecycle and native services,
even though it imports none of their packages at runtime:

| Boundary | Native owner | Use |
|---|---|---|
| Plugin load/ready/dispose | app-boot, Cordis loader/context | Absolute plugin row, service access, event listeners and teardown. |
| Agent factory and controls | dsh-agent, dsh-agent-loop | Create/resume handles; followup, steer, inject, cancel and inbox operations. |
| Durable session data | dsh-session, dsh-session-persistence | Native event envelopes, list/read/flush and saved cwd. |
| Stream shapes | dsh-agent, dsh-llm | Assistant stream publications and content chunks. |
| Fixture tool | dsh-tools | Test-only echo gate; a production bridge would not register it. |
| Child attribution | dsh-subagent and native spawn provider | Child start/end and parent catalog observations. |

These are evolving pre-stable interfaces. The current source tree has 91
English upgrade guides, not 91 bridge-breaking changes. Relevant examples
include [model-selection ownership](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/upgrade-guide/v0.2.1-alpha.4/session-model-selection/guide.md),
[session publication/write rules](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/upgrade-guide/v0.2.1-rc.2/session-store-writes/guide.md),
and [plugin compatibility metadata](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md).
The observed missing RC `agent.model` is direct evidence that a broad `0.2.x`
range is unsafe. Guide directory labels alone are not a compatibility matrix.

Use the tested **0.2.1-rc.5** as the primary target and **0.2.2-alpha.2** as an
additional explicit target. Admit only tested exact versions, and repeat native
controls before adding another. Probe actual services/methods at startup and on
agent creation; missing methods must become typed unsupported capabilities with
the reason in a future OAR adapter. Presence is necessary but cannot authorize
unverified semantics. An untested version is not admitted by this experiment.

## Internal transport sketch

Both endpoints would ship together in OAR; this is not a new public protocol.
The probe demonstrates these envelopes:

- First frame: protocol revision, process identity, and actual service/method
  inventory. Agent-specific methods are known after native creation and appear
  in its response before a prompt is accepted. A failed loader barrier produces
  a startup error; it must not be treated as an empty successful inventory.
- Commands: request id, operation, native session id and supplied input. Open,
  resume, prompt, steer, inject, cancel, queue, withdraw and close call native
  methods. Responses retain ids and refusal reasons; successful delivery is not
  equivalent to completed model work.
- Native frames: channel name and routing session id outside the unchanged
  native payload. Preserve unknown native event types. Observe turn completion
  from native `turn/end`, not from a transport response or an idle timer.
- Shutdown: dispose owned handles, flush native persistence and close stdin;
  all three launcher processes in each selected run exited 0.

Only the local experiment is implemented. Windows/macOS loading, real provider
authentication, image input, approval UI, crash recovery, pipe backpressure and
slow consumers, upgrade migration, and malformed-command hardening remain
unverified. `agent/error` is currently a diagnostic string in the probe, not a
lossless error-object transport contract. No OAR product code or default
capabilities change here. Adapter design follows review of these results.
