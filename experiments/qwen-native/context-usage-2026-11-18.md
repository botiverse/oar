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

No provider request occurred during any of the four measured queries. This
observation does not imply that unrelated background requests cannot overlap
a later readback; see the attribution control below.
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
during each query. This cost control disables native managed-memory extraction
in its isolated fixture with `memory.enableManagedAutoMemory: false`; ordinary
OAR sessions and other vendor cases keep their normal configuration. It also
requires exactly three provider requests across the three root turns. Failures
retain both sessions, query costs with provider-array boundaries, and all
provider bodies in `oar-trial-run/qwen-vendor/context.json`.

The additional pre-prompt sample initialized a separate empty process and
issued the same query before sending any user frame. It used no model request.

## Background request attribution

Release PR #928 failed the original cost assertion on Qwen 0.27.4:
one provider request arrived during its first 13 ms query and another during
its resumed 11 ms query. CI retained the query costs but omitted provider
bodies and resumed records, so those exact requests cannot be recovered.

A fresh reproduction with four independent fresh/resume pairs captured the
same failure once among twelve queries: a native managed-memory extraction
request arrived during a 23 ms context readback. Its last user message asks
Qwen to scan recent conversation history and update managed memory, rather
than to calculate context. The [selected evidence](context-cost-2026-11-18.json)
retains that request, its correlated context reply, the CI costs and controls.

| Native control | Root turns | Total provider requests | Memory requests | Context queries |
| --- | ---: | ---: | ---: | ---: |
| 0.27.4, default memory | 3 | 6 | 3 | 3 |
| 0.27.4, no context query | 3 | 6 | 3 | 0 |
| 0.27.4, managed memory disabled | 3 | 3 | 0 | 3 |
| 0.28.0, default memory | 3 | 6 | 3 | 3 |

In the 0.27.4 published bundle, `chunk-WG5L7ABP.js` schedules
`runManagedAutoMemoryBackgroundTasks` from normal model-turn completion;
`scheduleExtract` calls `runAutoMemoryExtractionByAgent`. This path does not
require a context query. `session-SKSTYW3C.js` handles `get_context_usage` with
local `collectContextData` from `chunk-UZO6QRXO.js`, reading the active chat,
local telemetry, tool declarations and skills. The native settings loader in
`chunk-G5CGBAH3.js` honors `memory.enableManagedAutoMemory: false`.

The no-query control also observed a memory request arriving after its first
native result, proving that this timing does not require a readback.

The faulty assertion attributed every HTTP request in a time interval to the
readback. Isolating native memory work keeps the zero-request assertion and
adds a whole-run count, so a delayed unexpected request also fails. This is a
test-fixture change, not a product setting or a removal of the cost check.
Default sessions can still perform background memory work alongside local
context readback. The older 0.26.5 observation that memory finished before
`result` is not an ordering guarantee for current Qwen.

Run the native controls with the selected executable. Each invocation makes
two fresh turns and one resumed turn against a local scripted provider:

```sh
OAR_QWEN_BIN=/absolute/path/to/qwen pnpm tsx \
  experiments/qwen-native/context-cost.ts oar-trial-run/context-query query
OAR_QWEN_BIN=/absolute/path/to/qwen pnpm tsx \
  experiments/qwen-native/context-cost.ts oar-trial-run/context-no-query no-query
OAR_QWEN_BIN=/absolute/path/to/qwen pnpm tsx \
  experiments/qwen-native/context-cost.ts oar-trial-run/context-memory-off memory-off
```

Each directory keeps `raw.json` with native frames, query boundaries and
provider bodies. The no-query control observes 200 ms after each native result;
that interval is a control observation, not an assertion that background work
has finished. Overlap depends on scheduling and need not recur in every run.
