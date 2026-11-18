# Kimi MCP startup catalog, 2026-11-18

Kimi 2.6.0 through 2.6.3 can finish MCP discovery after fixing an incomplete
model-facing tool catalog. The successfully discovered tools remain absent
from subsequent requests in that session. Waiting before the first prompt
does not repair the snapshot. This matches
[upstream #4904](https://github.com/MoonshotAI/kimi-code/issues/4904), with our
[2.6.3 ACP evidence](https://github.com/MoonshotAI/kimi-code/issues/4904#issuecomment-6981766030)
added there. This is distinct from MCP resume #5036 and notification #1138.

## Trigger and controls

The main CI run [44305731774](https://github.com/botiverse/oar/actions/runs/44305731774)
on `ba8c211e` failed the Kimi `tools/list_changed` assertion. Its installed
version was 2.6.3. The MCP log reached `tools/list`, but both actual conversation
requests contained 25 builtin tools and neither probe tool. There were no
background provider requests to misattribute. The fixture added no deliberate
delay and used an HTTP logging proxy; startup timing still exposed the
omission.

Linux x64, Node.js 24.19.0, unmodified npm packages, isolated homes and a local
scripted OpenAI provider. No login or real model request was used. The model
has no dynamic-tool-loading capability. We held only the first valid
`tools/list` response, leaving its contents and other MCP responses unchanged.

| Native version | Zero-delay control | Fixed 1000 ms delay |
| --- | --- | --- |
| 2.4.1 | Tool in both turns, 1/1 | Tool in both turns, 2/2 |
| 2.5.2 | Tool in both turns, 1/1 | Tool in both turns, 2/2 |
| 2.5.3 | Tool in both turns, 1/1 | Tool in both turns, 2/2 |
| 2.6.0 | Tool in both turns, 1/1 | Missing in both turns, 2/2 |
| 2.6.1 | Tool in both turns, 1/1 | Missing in both turns, 1/1 |
| 2.6.2 | Tool in both turns, 1/1 | Missing in both turns, 1/1 |
| 2.6.3 | Tool in both turns, 1/1 | Missing in both turns, 3/3 |

The direct ACP controls wait before the first prompt, after the MCP request.
The final reusable probe makes this stronger: it waits for the complete MCP
reply, then two additional seconds. No native source was patched. OAR session
controls on 2.6.3 also omitted the tool at 100, 1000 and 3000 ms; three zero-delay
controls included it. The warm native controls create a new session only after
a preparation turn has joined workspace MCP readiness: all three 2.6.3 runs
included the tool, including two with delayed preparation. This preparation
is confined to the independent native notification test.

[Selected results](selected.json) retain every run's tool-name projection and
timing marks. `turns` groups provider requests by the two measured turns;
`preparation` is separate. The selected native wire entries keep only probe
tools from `mcp.tools_discovered` and `tool_select.initialized`, showing that
discovery completed despite the missing provider declarations. Full provider
bodies, ACP frames and synthetic native homes remain local; they are not
needed to read this result.

## Source explanation

Source inspection at the 2.6.3 commit
`b0de2fbd2de04d87689225aafd3912e5d193b62d` is consistent with the observations:

- [Agent construction](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts#L305)
  starts the loop while constructing the agent.
- [Loop initialization](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/agent-core-v2/src/agent/loop/loopService.ts#L380)
  captures `requestFactory.baselineTools()` for the loop profile. The
  [request factory](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/agent-core-v2/src/agent/loop/requester.ts#L141)
  reads `toolSelect.initialTools()`.
- [MCP preparation](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/agent-core-v2/src/agent/mcp/mcpService.ts#L80)
  waits for readiness before a step, after that loop profile was constructed.

The source explanation does not claim a tested native fix. OAR neither edits
native snapshots nor invents missing declarations.

## Reproduce

Install the checkout's locked dependencies, then use an absolute path to the
chosen native binary. Each run creates fresh synthetic homes and writes raw
frames, provider traffic and selected summaries to a new output directory.
The native paths do not open an OAR runtime session; the shared process helper
only transports ACP and owns cleanup.

```sh
npm install --prefix /tmp/kimi-263 @moonshot-ai/kimi-code@2.6.3
pnpm tsx experiments/kimi-mcp-startup/probe.ts /tmp/kimi-263/node_modules/.bin/kimi /tmp/kimi-startup-263
```

The probe runs a cold zero-delay session, a cold 1000 ms session, and an
undelayed workspace server with a prepared native session. Each measured
session gets two prompts around `notifications/tools/list_changed`. Repeat
with 2.5.3 to observe the last release before the 2.6.0 regression.

## CI contract

[The Kimi vendor controls](../../sea-trial/vendor/kimi-mcp-catalog.vendor.test.ts)
separate the two questions:

1. The notification control uses a workspace server with no intentional
   response delay. A completed native preparation turn joins discovery before
   the measured session is created in the same process. Both measured turns
   must offer exactly the original probe tool; no relist may occur. This
   keeps `mcpToolsListChanged: "none"` strict without depending on first-session
   startup timing. No retry or optional catalog assertion is involved.
2. The cold OAR session delays the first list reply by 1000 ms, waits for the
   reply and two more seconds, then asserts two missing catalogs from 2.6.0
   onward and two complete catalogs on earlier versions. #4904 is linked beside
   the assertion. Change the affected range and require complete catalogs once
   a fixed native release passes this same delayed control.

The production adapter, CI baseline, notification observation window and
existing runtime declaration remain unchanged. This test preparation is not
a supported host workaround for session-specific MCP servers.
