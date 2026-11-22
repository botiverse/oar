# Patched Kimi KAP session controls

The patched CLI preserved root-agent instructions through compaction and restart, and identified the immediate parent of both steered turns on live events and cold replay. Per-session MCP connections stayed isolated and rotated while idle. Tool availability still depended on when the CLI captured its first model-facing catalog. A server could finish discovery and be absent from the prompt. A removed server could leave a visible schema whose calls failed.

These Linux x64 observations use Node 24.19.0, a local scripted OpenAI-compatible model, fresh data homes and the fork at `d5fea15a7` on November 22, 2026. The model used the default tool-loading settings. Every server boot reported version `2.7.2-botiverse.0` and all three capabilities under `GET /api/v1/meta`. The official 2.7.2 measurements are a separate baseline. [Fork source](https://github.com/botiverse/kimi-code-sdk/tree/d5fea15a76e2102cb742e0f1b24debf730478ccc), [official wire report](../README.md). `mcp[2]`

## Session MCP

Supply `mcp_servers` on `POST /sessions` or `POST /sessions/{id}:resume`. The first column below describes what the host supplied. H1 to H3 identify HTTP fixture instances by their request header. S1 and S2 identify stdio children by their process environment. The provider received each generation in the tool response. All configured peers published the same tool name, `mcp__slot__observe`.

| Host action | Observed execution |
| --- | --- |
| Create two sessions in the same workspace with different HTTP bindings and a third with the field omitted | The first two called H1 and H3 respectively. The third saw no tool and made no call. `mcp[17,23,27]` |
| Replace the first session's server and rotate the second session twice under the existing name | The first called H2. The second switched from HTTP to stdio S1 and then to stdio S2. Omitting the field on a warm resume retained H2. `mcp[38,44,50,57]` |
| Replace MCP during a held Bash call, first alone and then together with appended instructions | Both requests returned HTTP 200 with envelope code 40901 (`SESSION_BUSY`). The next request still used the old instructions and called H2. `mcp[60,61,67,69]` |
| Restart the CLI, then omit the field on resume | The provider still saw the saved schema. Its tool call returned “not found” and reached zero fixture endpoints. `mcp[81]` |
| Resume cold with a new stdio binding, then clear it with `mcp_servers: {}` | The first call reached S1. After the clear the provider still saw the schema, but the call returned “not found” and reached no endpoint. Both requests also applied the corresponding instruction update. `mcp[82,85,87,88,91,93]` |

At five checkpoints spanning creation, rotation, restart, clear and shutdown, the isolated Kimi home contained no global `mcp.json` and no file contained any of the five synthetic connection markers as literal bytes. The session retained tool names and result history, as the cold control shows. `mcp[28,70,73,94,97]`

Create and idle resume rejected the reserved names `__proto__`, `constructor` and `prototype`, and a whitespace-only name, with code 40001. The pre-existing session answered its next prompt with the same empty catalog. `reserved[5,7,9,11,13,15,17,19,23]`

### Discovery and the first provider request

For each fresh session, the fixture observed its MCP handshake, the probe read the native `mcp.tools_discovered` record for the session, and the model recorded its actual `tools[]`. A model call was made only for a tool included in that request.

| Fresh session configuration | Native registration | First provider request |
| --- | --- | --- |
| Stdio without a server-level `environment_id` | Create returned code 0. The child received no handshake. | Schema absent. `discovery[3,7]` |
| Same stdio fixture with `environment_id: "local"` | Child received initialize, initialized notification and tools/list. Kimi recorded the enabled tool. | Schema absent. `discovery[8,12]` |
| HTTP with an immediate tools/list | Kimi recorded the enabled tool. | Schema present. Its call returned H1. `discovery[22]` |
| Same HTTP fixture with a 500 ms tools/list delay | Create returned before the list response. The model request arrived after the list response, and Kimi recorded the enabled tool. | Schema absent on the first request and a separate second prompt after discovery. `discovery[25,27,28,30,34]` |

Two independent reruns in new processes and homes reproduced all four discovery results and the missing schema on the second prompt. `discovery-repeat-1[7,12,22,30,34]` `discovery-repeat-2[7,12,22,30,34]`

For a host that promises managed tools on the first turn, the capability bit, successful create and completed discovery leave the model-facing catalog unverified. The complementary removal control shows why reading the schema alone cannot establish that a live endpoint is attached.

## Appended system instructions

`append_system_prompt` is a top-level create and resume field. The provider inspected only system-role messages when looking for each synthetic instruction. Omission, replacement and an explicit empty string had distinct effects.

| Operation | Provider observation |
| --- | --- |
| Create with A and create a second session without it | A appeared in the first session only. `instructions[3,6,9]` |
| Omit the field after a process restart | The next root request still contained A. `instructions[15,17]` |
| Replace with B on cold resume, then C on idle live resume | Each subsequent root request contained just the current marker. An active update returned 40901. `instructions[23,25,27,29,33]` |
| Compact and run a foreground Agent tool | After the manual compaction item ended successfully, the next root prompt contained C. The parent that invoked Agent contained C, the child's own system message carried none of the four markers, and the child task ended under the parent's tool call ID. `instructions[40,45,51,53,56]` |
| Clear with an empty string, restart, then omit the field | The next root request and the cold follow-up both carried none of the markers. `instructions[60,64,71,73]` |

## Steered turn correlation

The host posted two successive steers while real Bash tools were held, first during the original turn and then during the first steered turn. Each held tool ran once. The probe also submitted an ordinary follow-up. All four native turns ended with `outcome: "completed"`. `steer[8,9,12,13,14,17,19,25]`

| Native turn number | `steered_from_turn_id` | `steered_from_turn_number` | `steered_from_prompt_id` |
| --- | --- | --- | --- |
| 0 | absent | absent | absent |
| 1 | ID of turn 0 | 0 | Q410_PARENT |
| 2 | ID of turn 1 | 1 | Q410_FIRST |
| 3, ordinary follow-up | absent | absent | absent |

The three parent fields agreed on live `turn.started` and `turn.ended`, on `GET /sessions/{id}/agents/main/turns` after process restart, and on the new subscription's `turns` snapshot. Follow the immediate parent links to group a chain under its original host turn. `steer[5,10,15,21,33,34,35]`

## Reproduction

Build the pinned fork using its pnpm 10.33.0 workspace, then run the probe on Linux with Python 3.12. Each invocation requires a new output path. The probe creates a disposable workspace and starts its own loopback CLI, provider and MCP servers. It closes the socket and waits for CLI shutdown before removing the fixture.

```sh
git clone https://github.com/botiverse/kimi-code-sdk.git kimi-patched
git -C kimi-patched checkout --detach d5fea15a76e2102cb742e0f1b24debf730478ccc
(cd kimi-patched && CI=1 pnpm install --frozen-lockfile && pnpm --filter '@moonshot-ai/kimi-code...' run build)
python3 -m venv .probe-venv
.probe-venv/bin/pip install aiohttp==3.13.3
for scenario in mcp discovery reserved instructions steer; do
  .probe-venv/bin/python probe.py "$scenario" "$scenario.jsonl" node "$PWD/kimi-patched/apps/kimi-code/dist/main.mjs" || exit 1
done
```

Each citation identifies a scenario and its observation numbers in the selected JSONL. REST and WS rows project native messages, provider rows describe actual model requests, and fixture summaries join observations from the indicated endpoints. Generated identifiers retain equality within each scenario. Connection values and machine paths are excluded. [Probe](probe.py), [selected observations](wire-samples.jsonl).
