# Qwen current context after a root turn

Qwen Code 0.28.0 on Linux x64, 2026-11-18. All requests used a scripted
provider in an isolated HOME and workspace. No account or paid model was used.

`get_context_usage` reports current occupancy separately from the cumulative
`result.usage`. The [selected native responses](context-usage-2026-11-18.json)
contain the four context responses cited below, the three result usage objects
and local timing/provider-request observations. Full local transcripts remain
outside the repository.

| Native boundary | `totalTokens` | Cumulative result input | Window | `isEstimated` | Query time | Provider requests during query |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Fresh turn 1 | 8,762 | 8,762 | 272,000 | false | 14.805 ms | 0 |
| Fresh turn 2 | 8,773 | 21,652 | 272,000 | false | 2.345 ms | 0 |
| Resumed turn 1 | 8,827 | 34,606 | 272,000 | false | 14.834 ms | 0 |
| Before the first prompt | 0 | No result | 272,000 | true | 40.301 ms | 0 |

Initialization advertised `capabilities.can_get_context_usage: true`. Each
query sent `{ "subtype": "get_context_usage", "show_details": false }` in a
native `control_request`. Its matching `control_response` contained
`response.response.subtype: "get_context_usage"`, `totalTokens`,
`contextWindowSize` and `isEstimated`.

The second and resumed readings rule out using cumulative input as current
context. Before the first prompt, native zero is explicitly estimated; OAR
keeps the count and percent unknown while preserving the window. A positive
estimate also remains unknown because the common context shape has no
estimated-count marker.

## Native source and query cost

In the [published 0.28.0 package](https://www.npmjs.com/package/@qwen-code/qwen-code/v/0.28.0),
`chunks/session-M3KRNGMT.js` implements
`SystemController.handleGetContextUsage` by calling local `collectContextData`.
`chunks/contextCommand-DKRL3RBJ.js` reexports its implementation from
`chunk-47F2Q6R7.js`. That collector reads the active chat's last prompt token
count, falling back to local telemetry when no active chat exists. A missing
positive count sets `isEstimated`; the chat can also mark its count estimated.
The category breakdown uses local estimates and is not OAR's total.

No provider request occurred during any of the four measured queries.
The post-turn timings exclude native startup and model execution. These are
Linux measurements, not a latency guarantee for all platforms. OAR gives the
optional query a one-second bound and records a rejection when no reply arrives.

## OAR ordering and limits

The shared stream-json driver holds root completion and queued input while
Qwen awaits the reply. Private control replies remain consumable outside that
queue. The correlated context frame precedes the original result's projected
`turn_ended`; the result retains its original ingress timestamp. A caller
observing turn completion can therefore read the new context immediately.

Child results do not trigger root queries. An aborted root turn skips the
readback. A missing capability, malformed response, refusal, timeout, exit or
disposal never turns cumulative usage into context. Without a new reading,
`contextUsage()` retains its last known reading, or null before any reading.
A late response is raw evidence only and cannot update the next turn's context.
The native result and process exit still settle; query failure does not kill
an otherwise usable process.

Fresh and resumed native adapter controls passed on both 0.28.0 and the
CI-pinned 0.27.4. No runtime pin, baseline or minimum version was changed.
Unit controls cover correlation, child attribution, queued and observer-issued
input, timeout, refusal, unsupported capability, abort, exit and disposal.

## Reproduce

With the selected executable installed, run from the repository root:

```sh
OAR_TEST=qwen-aimock OAR_QWEN_BIN=/absolute/path/to/qwen \
  pnpm exec vitest run sea-trial/vendor/qwen.vendor.test.ts \
  -t 'fresh and resumed context'
```

This creates a local provider and isolated native configuration, executes two
fresh turns and one resumed turn, compares projected context with native
responses, checks ordering before turn end and requires zero provider requests
during each query. Failures retain records and observed query costs in
`oar-trial-run/qwen-vendor/context.json`.

The additional pre-prompt sample initialized a separate empty process and
issued the same query before sending any user frame. It used no model request.
