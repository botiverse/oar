# Antigravity ACP steering: 2026-10-29

There is no verified in-flight steering route through **agy_acp_server 1.4.4**.
A concurrent `session/prompt` waits until the current model/tool loop finishes;
it also exposes a native stream-consumer race. OAR keeps its absent `steer`
member and host-side queue. No adapter or shared ACP code changes.

## Version and method

- Linux x64 on xxwork, server and companion `localharness_external` from the
  [official 1.4.4 archive](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.4-linux-x86_64.zip),
  listed in the [ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
  Archive SHA256: `baf31b7a97602dee359cf2a43f72b6e11c6bf354be874987d80660cd3526bb6a`.
- `initialize.agentInfo.version` reports `1.4.4` in every trial.
- Real ACP server and bundled harness, a local scripted Gemini provider,
  dummy key, a local echo MCP tool and a separate temporary home per trial.
  No personal login or account quota; this does not establish personal-login
  behavior or exhaust every timing window.
- The [probe](antigravity-steering.ts) holds the first model response, sends
  the second prompt while the first RPC is pending, waits 250 ms, then lets
  the first model call the echo tool and answer its result. It checks every
  provider request for both input markers, the tool result and the first
  final answer. A sequential control awaits the first RPC before sending
  the second prompt. All RPCs and the whole trial have deadlines.

Run with the server and companion installed together:

```sh
OAR_ANTIGRAVITY_BIN=/path/to/agy_acp_server.par \
  pnpm tsx experiments/antigravity-steering.ts
```

The output directory defaults to `oar-trial-run/antigravity-steering` and can
be overridden with `OAR_PROBE_DIR`. It retains each trial's complete native
wire stream and observations. The committed [selected evidence](antigravity-steering-2026-10-29.json)
contains timings, marker presence, prompt outcomes and agent text without
temporary paths or native session identifiers.

## Source chain [src]

Paths refer to Python source distributed inside that exact server archive,
not a public source checkout. ACP-server paths below are relative to
`google3/cloud/developer_experience/antigravity_extensions/acp_server/`;
SDK paths are relative to `google3/third_party/py/`.

| Location | What it establishes |
| --- | --- |
| `server.py:5580-5711` | `prompt()` accepts extra kwargs but does not inspect them. It calls `agent.chat()` and then iterates the same conversation's step stream. No prompt priority or send-now branch. |
| `request_meta.py:23-53`, session creation/load paths in `server.py:3723-4323` | Antigravity metadata configures tools, MCP and system instructions when creating or restoring a session. It does not supply an in-flight prompt control. |
| `google/antigravity/agent.py:267-296`, `google/antigravity/conversation/conversation.py:93-120,191-209` | `chat()` calls `send()`. If busy, `send()` attempts to drain the old turn; when another consumer owns it, it waits for idle before sending the new input. |
| `google/antigravity/connections/local/local_connection.py:476-485,532-540` | Only one step-stream consumer is allowed. A second raises `RuntimeError`; idle waiting also drains queued steps. |
| `server.py:5862-5872,5906-5915` | The broad `RuntimeError` handler emits a connection-lost message; the prompt can still return `end_turn`. |
| `acp/agent/router.py:142-148,191-211`, `server.py` class `AgyAdapter` | The ACP router dispatches `session/prompt`; the adapter defines no private extension handler for steering. Its prompt kwargs are unused. |
| `google/antigravity/connections/local/local_connection.py:675-679` | A lower-level SDK `send_trigger_notification()` sends an automated trigger, but the ACP adapter neither calls nor exposes it. This is not an available OAR transport control. |

This conclusion is scoped to the inspected ACP implementation. The existence
of an internal SDK trigger does not establish a supported ACP method, and
OAR does not reach through the process to use that connection.

## Results [obs]

Every trial issued exactly three provider requests:

1. First input, no second input and no tool result.
2. First input plus the echo result, still no second input.
3. Both inputs, the echo result and the first final answer.

Thus the second input did not join the active tool loop. It became a later
model turn. While the first response was held, the concurrent cases produced
no second provider request and no prompt response.

The concurrent route is not a reliable native queue either. In all three
final trials, the second RPC returned `end_turn` before the second input even
reached the provider. The original first RPC remained pending until after
the second answer. Both answers arrived as unscoped session text, together
with an error saying that concurrent `receive_steps()` calls are unsupported.

Times below are milliseconds relative to sending the second prompt:

| Trial | First final text | Second RPC `end_turn` | Second input reaches provider | Second final text | First RPC `end_turn` |
| --- | ---: | ---: | ---: | ---: | ---: |
| busy 1 | 282 | 293 | 328 | 332 | 339 |
| busy 2 | 278 | 289 | 329 | 334 | 341 |
| busy 3 | 280 | 291 | 326 | 330 | 338 |

The sequential control returned the first RPC before the second prompt was
sent, then returned the second RPC after its answer. It emitted no concurrency
diagnostic. Both the first and final probe batches produced the same result:
six busy trials total, plus two passing sequential controls. The source's
single-consumer rule and broad error handler explain the observed diagnostic;
the provider and ACP wire timestamps establish the crossed completion order.

An initial probe attempt failed while serializing the ACP callback context,
which contains a circular connection object. Its wire capture was retained.
The probe was corrected to record the callback's `params`; no runtime setting,
timeout, retry or assertion was changed to hide a native failure. A later
type-check fix passes the already-validated binary path into the trial helper.

## OAR decision and follow-up

Keep prompts serialized in OAR and keep `steer` absent. The host queue waits
for the first native prompt response before sending its next input, matching
the successful control. `steerOrQueue()` and default `deliver()` use that
queue; explicit interrupt delivery remains a separate abort-and-prompt path.

Re-run this probe whenever Antigravity is upgraded during the daily runtime
check. Revisit the mapping only when a native in-flight input path is both
present in the ACP implementation and verified without these completion or
stream-consumer errors.

## agy CLI UI and stream-json

The official CLI's separate release was **1.4.9**. Download came from its
[public update manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json),
using the [versioned archive](https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.9-4962164969177088/linux-x64/cli_linux_x64.tar.gz).
Its SHA512 matched the manifest:
`96a259b7475ae70a5b002ea8a83b804bba9b6ad2171af0cd0839b3959d9e6046ba36e181bc2d5597522aeceaacc06023564c46232fdb958f26f8c72267d9f0fd`.
The CLI and ACP versions are different products, not interchangeable version
numbers.

The [CLI probe](agy-cli-steering.ts) drives the real interactive UI through a
small [POSIX PTY bridge](agy-cli-steering/terminal_bridge.py), then drives its
public NDJSON input. Both use isolated HOME, the documented Gemini provider
configuration, a dummy key and the same real echo MCP process. No OAuth or
internal language-server endpoint is called. `--dangerously-skip-permissions`
is limited to these isolated local fixtures. The default configured Gemini
model is used; the test does not claim account/model catalog coverage.

```sh
OAR_AGY_BIN=/path/to/antigravity pnpm tsx experiments/agy-cli-steering.ts
```

The probe holds the first inference, enters a second message, waits 700 ms,
and releases a valid `call_mcp_tool` response. Title-generation requests are
separate from the measured conversation. Each case has a 50 s deadline;
the PTY bridge terminates its owned process group on input closure.

| Case | Requests before releasing the held inference | First request containing second input | First final answer already in that request? |
| --- | ---: | --- | --- |
| UI queue control | 1 | After the echo result and first answer | Yes |
| UI immediate, three trials | 1 each | Echo-result request in the active loop | No |
| stream-json, even with immediate UI setting | 1 | After the echo result and first answer | Yes |

The UI therefore has real mid-turn input at the next model invocation. It
does not cancel the in-progress inference. Queue and stream-json each make
three model requests; immediate mode makes two. Native logs independently
record forwarding a mid-turn message and `SendUserCascadeMessage` handling.
Stream-json returns two successful results with one conversation id. Both
`control_request` and `control_response` are explicitly rejected with exit 2.
The [selected CLI evidence](agy-cli-steering-2026-10-29.json) contains marker
observations, not prompts, accounts or machine identifiers.

Early fixture failures are retained locally: invalid settings type, onboarding
input consumed by the project trust dialog, a model preset that selected the
wrong provider, and unsupported extra properties in the mocked MCP tool call.
Those attempts do not establish native steering behavior. The finalized
fixture accepts only its temporary project, uses the default Gemini provider
and sends the tool's actual schema. Packaging the helper initially shadowed
Python's `pty` module; the stream assertion initially read the envelope rather
than its nested result. Both probe defects were fixed before the final batch.
No failed attempt is counted as a passing native trial. A later repeat also
reached the correct second provider request but timed out waiting for a
contiguous answer word in terminal output: native cursor redraws split that
word. The final probe measures UI input delivery at the provider boundary
and retains the raw screen output without claiming a machine-readable UI
completion event; stream-json still checks both native result envelopes.

The [runtime page](../docs/runtimes/antigravity.md#cli-versus-acp-checked-october-29)
contains the full comparison of turns, cancellation, resume, configuration,
MCP, permissions, usage, payload size and updates. Both entry points are
vendor-native. ACP remains the selected host interface; a smaller CLI payload
and an interactive feature do not replace its control methods.

## Internal interface facts, not an integration proposal

### Shape and layer [binary/obs]

The CLI binary embeds protobuf descriptors for service
`exa.language_server_pb.LanguageServerService`. Its
`SendUserCascadeMessage` method accepts `SendUserCascadeMessageRequest` and
returns `SendUserCascadeMessageResponse`. This is an RPC-shaped interface,
not merely a UI function with an evocative name.

Selected request fields, decoded from the distributed descriptors:

| Group | Fields |
| --- | --- |
| Conversation/input | `cascade_id` (string, field 1), `items` (repeated TextOrScopeItem, 2), `images`, `media`, artifact/file/diff comments |
| Context/configuration | `metadata`, `experiment_config`, `cascade_config`, `custom_agent_spec`, `active_profile`, `user_identity`, `editor_state`, `custom_extensions` |
| Delivery | `blocking` (bool, 8), `propagate_error` (bool, 16), `continue_after_injection` (bool, 20), `delivery_strategy` (enum, 22) |
| Other provenance/input | `additional_steps`, `client_type`, `planner_response`, `message_origin`, `tags`, `remote_control_details`, `sender_window_id` |

`MessageDeliveryStrategy` has three declared values:
`UNSPECIFIED = 0`, `NEXT_INVOCATION = 1`, `WHEN_IDLE = 2`
(each has the prefix `MESSAGE_DELIVERY_STRATEGY_`). The names match the
observed boundary, but the probe does not claim every enum combination works
or that unspecified equals a particular policy.

Go function metadata identifies the UI route through
`store.(*Manager).sendMessageOrSteer` (`input_loop.go:1137`),
`sendImmediateMidTurn` (`input_loop.go:1316`),
`backend.(*ServerBackend).SendUserMessage` (`server.go:1827`) and
`sendUserCascadeMessage` (`server.go:1869`). The runtime log records these
input/backend stages. These paths and line numbers came from binary metadata
and logs, not a public Go source checkout.

In all three final UI trials the language-server startup log's PID equals
the PTY child's agy PID. The language server is embedded in this CLI process,
which also listens on random localhost HTTP and HTTPS/gRPC ports. This is
not evidence that the UI starts ACP's separate `localharness_external`.
The exact frontend call's wire traversal was not captured; an RPC client
interface and live listeners do not by themselves prove that every UI call
crosses a process boundary.

### Can another process reach it? [binary/src; not invoked]

A customization helper shipped as plaintext inside the official CLI binary
names a local Connect endpoint, with route shape
`/exa.language_server_pb.LanguageServerService/<method>`, HTTP JSON bodies,
address variable `ANTIGRAVITY_LS_ADDRESS` and header `x-codeium-csrf-token`
from `ANTIGRAVITY_CSRF_TOKEN`. It demonstrates external client access for
plugin-management methods. The binary also includes missing/invalid CSRF
validation diagnostics. The helper's fallback port is not a stable port;
the observed processes choose random ports.

This supports a technically addressable, authenticated local service. It does
not establish that an arbitrary external caller may use
`SendUserCascadeMessage`, how to acquire a valid token outside the intended
child environment, its lifetime, or any stable compatibility promise. No
request was sent to that internal endpoint, no token was extracted, and no
authentication bypass was attempted.

ACP 1.4.4 follows a different connection path. Its bundled Python
`connections/local/local_connection.py:1490-1545` starts
`localharness_external`, exchanges length-prefixed protobuf startup messages
on stdin/stdout, then connects to a localhost WebSocket. The startup answer
contains `port` and `api_key`; the WebSocket client sends `x-goog-api-key`.
That SDK uses its own conversation/trigger messages. This proves a different
wire interface, not that `LanguageServerService` is reachable through ACP.
No inspected ACP source exposes `SendUserCascadeMessage` or its delivery enum;
shared implementation inside the two proprietary engines remains unverified.

### Source availability and reproducibility

| Component | Material inspected | What is not established |
| --- | --- | --- |
| agy 1.4.9 | Official ELF binary: Go names/line metadata, protobuf descriptors, bundled helper text; native logs and local-provider probe | The [public repository](https://github.com/google-antigravity/antigravity-cli) contains documentation, examples and issue templates, not this implementation. Public hosting is not an open-source release of the engine. |
| ACP 1.4.4 | Python server, SDK and generated protocol code distributed inside the `.par` archive | No public implementation repository or open-source license for that package was established. Available source inside a download is a different claim. |
| `localharness_external` | Native companion binary plus the Python client's startup/WebSocket code | No engine implementation source was found in the inspected distribution; do not infer all internal methods from the client. |

To reproduce the static observations, use those exact hashed downloads:
inspect the `.par` ZIP entries for the paths above; run `strings -a` on agy
for the named symbols, CSRF variables and helper; decode its embedded
`third_party/jetski/language_server_pb/language_server.proto` and
`third_party/jetski/cortex_pb/cortex.proto` FileDescriptorProto payloads.
In this Linux binary those descriptors start at file offsets `0x61d3b7a`
and `0x62554c4`. Offsets are version-specific, not a supported extraction API.
Only summarized interface facts are committed, not proprietary source,
complete descriptors, system prompts or disassembly.

### Published terms, checked October 29

[Antigravity Additional Terms, paragraph 6](https://antigravity.google/terms)
restrict third-party software access to the service and explicitly give
third-party reuse of Antigravity OAuth as an example; the stated consequence
can include account suspension. The page excludes the enterprise services
and Gemini Enterprise API key arrangements listed in its opening paragraph,
which follow their applicable administrator agreements. It does not name
this RPC or grant a public host API contract. These are the published terms'
statements and scope, not a conclusion about every OAR deployment or this
isolated dummy-provider experiment.

The technical decision stays unchanged: no internal RPC integration. Notify
the maintainer if agy stream-json or ACP publishes an immediate-send/control
request contract, then reassess against that contract and native evidence.
