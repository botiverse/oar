# Kimi 2.7.2 KAP wire contract

A host can correlate a prompt, account for usage, classify provider errors and attribute child tools using the public Kimi Agent Protocol (KAP). It must subscribe before submitting a prompt. The first turn events can precede the HTTP reply. A successful HTTP reply to cancel, compact or shut down also precedes the effect the caller cares about.

These captures use the official `@moonshot-ai/kimi-code@2.7.2` executable, Node 24.19.0 and Linux x64 on November 22, 2026. The executable ran its real tools in disposable workspaces. A loopback model supplied known responses and counted the calls. No model traffic used a personal account. This experiment covers the unpatched protocol. Per-session MCP, appended instructions and steered-turn parentage are tracked separately. [Release source](https://github.com/MoonshotAI/kimi-code/tree/56145f849caa305d42acd09b67fb65d11146f887), [MCP](https://github.com/MoonshotAI/kimi-code/issues/4975), [instructions](https://github.com/MoonshotAI/kimi-code/issues/5226), [steering](https://github.com/MoonshotAI/kimi-code/issues/5227).

Names and numbers in backticks identify the scenario and observer sequence in the [selected wire samples](wire-samples.jsonl). Each HTTP sample names its request method and path. Each WebSocket sample identifies the connection and records the native payload. Large histories and catalogs are excerpted. Generated identifiers are consistent within each scenario. Sequence numbers describe the observed arrival order at one client.

## 1. Startup, authentication and workspaces

Launch the selected executable as `kimi web --json --host 127.0.0.1 --port 0`. The first stdout line provides `origin`, `ws_url`, an ephemeral bearer and `kimi_agent_protocol_version: "1.0.0"`. Verify `GET /api/v1/meta` for the server version. Plain `kimi web --no-open` printed a seven-line human-readable banner including a local URL and a token label. Treat both forms of stdout as sensitive. REST uses the bearer header. WS uses the `kimi-code.bearer.<token>` subprotocol. Requests below are relative to `/api/v1`. `startup[1,4,24]`

KAP authentication and model authentication have distinct observables. With no KAP bearer, both session creation and prompt submission returned HTTP 401 with envelope code 40101. With a valid KAP bearer and a fresh provider-free home, `GET /auth` reported zero providers and `models_ready:false`, the model list was empty and OAuth usage returned an error inside a successful envelope. Session creation succeeded and the prompt was admitted as running. Its terminal error was `model.not_configured`; the model received zero requests. Model-side HTTP 401 is covered in section 5. `inventory[6,40]` `account[6,8,10,12,20,36,38,50]`

Changing only `KIMI_CODE_HOME` to a second directory with identical model configuration gave an empty session list and 40401 for the first session. Switching back recovered it. With `KIMI_MODEL_NAME`, `KIMI_MODEL_PROVIDER_TYPE`, `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_API_KEY` and `KIMI_MODEL_CAPABILITIES` set, the catalog added `__kimi_env_model__` under `__kimi_env__`. The local provider observed the configured model and fixture credential. Explicitly selecting a file-configured alternative used that provider's settings. `startup[6,13,15,22]` `env[6,26,52]`

`POST /workspaces` accepted an absolute root, name, additional directories and idempotency key. Repeating the request returned the same managed workspace ID. A relative root returned 40001. Create a session with `workspace_id` or `cwd`; omitting both returned 40001. Deleting the fixture's managed workspace removed its registry entry. Its session remained readable, and its source file still existed. `inventory[21,23,25,32]` `workdir[148,151,153,154]`

## 2. Model and thinking selection

`GET /models` reported provider, model ID, display name, context size and capabilities. A `thinking` capability indicated support without enumerating effort levels. Set `agent_config.model` and `agent_config.thinking` at create, or POST them to `/sessions/{id}/profile` after reopening. The profile response contains `data.agent`. On WS, subscribe to `main` for its `agent` snapshot and updates. Plain `GET /sessions/{id}` describes the session and omits these selections. A two-field update emitted intermediate WS snapshots, so use the applied pair from the response. `inventory[10]` `model[19,46,80,86,88,90,91]`

| Requested setting | Applied setting and actual provider request |
| --- | --- |
| Alternate model, thinking off | WS reported `alternate/off`. The provider received `alternate` with no effort field. `model[19,32]` |
| Fixture model, thinking on | WS persisted `fixture/on` across process restart. The provider received `reasoning_effort:"medium"`. `model[57,80]` |
| High at create, low after restart | WS restored high. The profile response applied low. Both requests carried their selected effort. `effort[8,22,44,51,61]` |
| Unknown catalog ID | Create and profile update both returned HTTP 200 with code 40001. `model[4]` `inventory[102]` |
| Arbitrary thinking string | Create accepted the string. A profile update echoed another arbitrary string on WS and forwarded it as the provider effort. A successful update alone cannot establish provider support. `model[9,113,115,123]` |

## 3. Cold resume and working directory

Restart the server with the same data home and reopen the native ID. The session, subscribed history and follow-up prompt survived process replacement. Starting the second server from a different process cwd still returned the original session cwd. A real Bash tool confirmed its working directory was the original workspace on both sides. An adapter that requires a specific cwd can compare it before returning a resumed handle. Unknown session GET and `:restore` both returned HTTP 200, code 40401, suitable for `SessionNotFoundError`. `:restore` also unarchives a known session. `workdir[36,59,85,97,126,143,145]` `lifecycle[38,47,54,56]`

Archive, restore and delete are explicit session actions. Closing a socket or shutting down the server preserved the session. A second server using the same data home could read a live session summary, but its own prompt snapshot showed no active request. Its profile mutation returned 40931 while the first server held the session. Do not derive ownership or idleness from a different process's prompt snapshot. `claimed[28,30,32]`

## 4. Prompt, text, tools and usage

Subscribe first. Send `POST /sessions/{id}/prompts` with a host-generated `prompt_id` and typed content. On this connection, `turn.started` arrived at 16, the user item at 17, and the HTTP acceptance at 20. The user item's `prompt_ids`, `item_id` and `placement:"opener"` join the host request to the native `turn_id`. Both text and reasoning began with initial content in `item.started`. Subsequent `item.delta.field:"text"` appended to the identified item. The terminal item repeated the complete string. Replace or reconcile that snapshot to avoid duplicate text. `conversation[16,17,20,23,24,25,26,27,28]`

A fragmented tool call began at `stage:"input"` with `input_text`, followed by an `input_text` delta. `item.updated.set` supplied parsed arguments, an executing stage and display metadata. Bash streamed `field:"output"`. Read and Write completed with structured paths, outcomes and output. With yolo selected, the Write completed and the file existed. A missing-file Read failed locally, then the provider continued and the enclosing turn completed. Agent uses the same tool-call envelope and emits a separate child task, detailed below. `toolstream[23,25,26,28,55,56,59,86,87,92,122,138]` `conversation[78,88]`

`turn.updated.step.usage` and `turn.ended.turn.usage` both carried token accounting. One step gave 1,200 uncached input, 34 cache-read, 0 cache-creation and 10 output. A two-step turn totaled 2,400 / 68 / 0 / 20. Count the aggregates once. Project the final totals before emitting OAR's terminal event. WS `context` carries the context occupancy and size limit. It can arrive before a turn ends or after it. It has no turn ID. `GET /sessions/{id}/context/summary` returned an ordinary HTTP 404 on 2.7.2. `conversation[29,30,34,60]` `workdir[28,46]` `inventory[98]`

## 5. Provider failures

Every request below was first accepted as running. On the subscribed public socket, all four ended with `turn.status:"ended"`, `outcome:"failed"`, `end_reason:"error"` and a structured `turn.error`. Use its code, HTTP status and retryability. A subsequent error notice describes the same failure. A fresh prompt after all four completed. The same 2.7.2 executable in ACP mode returned JSON-RPC error -32000 for HTTP 401. For 429, 503 and the provider-rejected model it returned the same `stopReason:"end_turn"` as the successful recovery prompt. This reproduces the earlier ACP finding with the same four responses used for KAP. `acpclasses[5,9,13,17,25]` [ACP evidence](../../docs/runtimes/kimi.md#failures), [upstream issue 1865](https://github.com/MoonshotAI/kimi-code/issues/1865).

| Scripted provider response | KAP error code | Retryable | Evidence |
| --- | --- | --- | --- |
| 401, invalid key | `provider.auth_error` | false | `classes[20,23]` |
| 429, rate limit | `provider.rate_limit` | true | `classes[41]` |
| 503, unavailable | `provider.api_error` | true | `classes[60]` |
| 404, model rejected by provider | `provider.api_error` | false | `classes[78,104]` |

The provider's model-specific 404 had no dedicated KAP model-rejection code. Preserve the status and native diagnostic. A 40001 raised during catalog selection is distinguishable before any model call. The fixture configured the CLI for a single attempt per step. The observed retryability flags do not measure default retry duration.

## 6. Cancellation, compaction, media, approvals and shutdown

**Cancel.** With Bash already running a child, both `POST /sessions/{id}:cancel` and `POST /sessions/{id}/prompts/{prompt_id}:abort` accepted the request. The corresponding turn ended `interrupted/user_cancelled`. The tracked Linux worker was gone by the wait readback and the next prompt completed. Idle session cancellation answered `cancelled:false`. A late per-prompt abort returned 40402. `midtool[28,30,40,44,64]` `abortbyid[27,37,60]` `queue[81,83]`

**Compact.** Empty history and an active model call each returned 40910. For an eligible idle session, `:compact` returned code 0 and `:wait` returned before the summary existed. Observe `agent.compacting:true`, the terminal `system/compaction` item and `agent.compacting:false`. A synthetic system turn for manual compaction arrived already marked ended in `turn.started`. Route it separately from a user turn. For the larger fixture, the item measured 31,035 to 30,812 tokens and the subsequent context snapshot read 30,812. For a small one, 14,049 increased to 14,567. A decrease is possible and is unsuitable as a completion test. `activecompact[45]` `compact[15,67,69,72,80,82]` `shrink[105,108,109,111,117]`

**Media.** A text-plus-image prompt and a separate image-only prompt both reached the model with image content. A local path supplied as an image produced a user attachment with file ID and a model message containing text and an image URL. A text-file path was a textual reference in the provider request. User-item attachments and provider observations are shown together. `media[17,22,40,45]` `imageonly[17,22,41,46]`

**Interactions.** In manual mode with an explicit ask rule for Write, both a question and an approval appeared as `interaction` frames. List pending interactions over REST. Reconnecting and resubscribing replayed the same pending ID. POST a matching answer or decision to `/sessions/{id}/interactions/{interaction_id}`. The question used question and option IDs. Approved and rejected writes produced separate terminal outcomes. A repeated resolution returned 40902; an invalid answer body returned 40001. `:wait` can return with `timed_out:false` and a pending interaction while the turn is still active. `interactions[25,32,37,45,46,50,83,94,103,106,127,163,168]`

**Shutdown.** Idle shutdown returned `ok:true`, then the owned CLI exited zero and its port closed. Mid-tool, `?if_idle=true` returned `ok:false`; unconditional shutdown returned `ok:true`. At 321 ms the CLI, worker and socket were still live. After the client closed the WS the CLI exited at 1,075 ms, the worker was absent and cold history marked the turn interrupted. In a separate control we kept the WS open: the tool and turn completed normally, and the CLI remained alive 6,159 ms after shutdown. It exited after client close at 6,237 ms. Dispose should close its sockets and await the process. Shutdown acceptance alone proves neither abortion nor cleanup. `startup[27,28]` `midtool[84,88,90,92,93,100]` `shutdownheld[27,69,72,74]`

## 7. Child agents and background tasks

A parent `Agent` item identifies its tool call. The parent's `task` frame carries `task_id`, `agent_id:"main"`, `child_agent_id`, `parent_tool_call_id`, `kind:"subagent"` and `detached`. Subscribe to the child ID and route its nested items by session, agent, turn and item. A late subscriber gets a turns snapshot before subsequent deltas. Child history is available under `/sessions/{id}/agents/{child_id}/turns`. The same native child name can recur in another session. `tasks[22,26,34,37,40,51,56,57,67]`

The foreground child completed its own Read and turn before the parent tool and turn ended. With `run_in_background:true`, the parent tool and initial parent turn completed first. The child then completed its Read and turn. The parent's task ended, and a new root turn opened with a notification item. Preserve this turn boundary and the child attribution. Background Bash also exposed `task.watch`, `task.output {offset,text}`, `task.unwatch` and `task.stop`. Stop returned the already-ended task on repeat; a missing task returned 40406. `backgroundchild[26,27,46,53,63,67,69,71]` `tasks[93,95,97,107,108,121,125]`

## Other adapter-facing controls

| Surface | Measured behavior |
| --- | --- |
| Native prompt queue | Reposting the same ID and body returned the original acknowledgment. Reusing the ID with different content returned 40927. A busy KAP session admitted a different ID as queued. Per-ID abort removed that queued entry; a second abort returned 40402. Replaying a completed ID returned its old queued acknowledgment without new execution. Preserve OAR's own busy/queue admission semantics. `queue[29,31,37,40,43,47,78,88]` |
| Process loss | After killing only the fixture CLI with one active and one queued prompt, the restarted process listed neither prompt. History retained the completed turn and an interrupted turn with `end_reason:"aborted"`. The never-started queued prompt was absent. A fresh prompt completed. `crash[47,50,56,58,83]` |
| Multiplexing and reconnect | Session-list updates reached an unsubscribed connection. Subscribed turn events carried session and agent IDs, including both concurrent root turns. Reconnect during an active prompt delivered a running snapshot and then its real terminal event. Missing session subscription failed immediately. Missing child subscription was acknowledged before `turns.failed`. Ignoring application-level pings closed the socket with 1001, heartbeat timeout. `multi[19,39,45,100,104,112]` `inventory[52,64,68]` `heartbeat-silent[14,15,16]` |
| History and fork | `GET /sessions/{id}/agents/main/turns?page_size=1` returned the newest page; `before_ordinal` selected the prior page. Zero page size returned 40001. Fork index 0 included the first user turn, index 1 included two. Forks had new session IDs and independent model histories. Out-of-range 99 returned 40001 and the source survived restart. `conversation[94,96,98]` `fork[76,85,92,101,108,118]` |
| Titles, tools, skills and goals | Setting a title through the profile persisted it in the session readback. Tool listing required a session ID to return its tool collection. A home skill was listed and activation opened a real turn; a missing skill returned 40415. An attempted prompt-level `disabled_tools:["Read"]` still advertised Read to the provider. This sample cannot establish a per-prompt policy guarantee. Goal create/pause/edit/resume produced live snapshots; resuming could initiate work, cancellation cleared the goal, and pausing without one returned 40914. `profiles[27,29,31,33,40,55,67,157,165,166,167,168,169,179]` `inventory[12]` |

## Reproduction

Use the [standalone probe](probe.mjs) on Linux with Node 24 and an installed copy of the official 2.7.2 CLI. For example, from this directory:

```sh
npm install --prefix /tmp/kimi-kap-wire --no-audit --no-fund @moonshot-ai/kimi-code@2.7.2
node probe.mjs classes /tmp/kap-classes.jsonl /tmp/kimi-kap-wire/node_modules/.bin/kimi
```

Each cited scenario is a command-line argument. Supply a fresh output path for each run. The probe starts a disposable home, workspace, model provider and CLI on loopback. It creates files below that home, waits for the scenario, closes owned processes and removes temporary workspace data. The trace retains request association and per-connection ordering. Ready-line credentials are redacted before writing. On rerun, match events and IDs rather than timestamps or sequence numbers. `midtool` inspects Linux process identity. The timings here describe individual runs. This expanded matrix has not been repeated on macOS or Windows.
