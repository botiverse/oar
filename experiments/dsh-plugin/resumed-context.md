# Context window after DSH resume

On Linux, DSH 0.2.2-rc.1 and 0.2.1-rc.5 both kept the request window in
the saved session after interruption. The fixture used a loopback provider
that reported 100 input and 12 output tokens for each completed call.

| Control | Native result | OAR context after the next committed call |
| --- | --- | --- |
| Same route, dispose during a held reply | `session.requestContext()` returned 128,000 during resume. The next turn sent no new `request/context`. | 112 of 128,000 (0% rounded). The new handle counted only its own call. |
| Same route, kill the test-owned DSH process during a tool turn | The new process resumed the same session ID and sent no new `request/context` on the next prompt. | 112 of 128,000 (0% rounded). |
| Explicit change to the model with a 256,000-token window | The first request on the new route emitted `request/context` with the new window. | 112 of 256,000 (0% rounded). |

Before the fix, the held-reply control on 0.2.2-rc.1 reported 112 tokens
with both the window and percentage null. DSH folds its persisted
`request/context` events into `session.requestContext()`. The loop emits
another event when the provider, model, window or system-prompt update
changes. Until the first request, the native read can return no context.

Run the [resume controls](../../sea-trial/vendor/dsh.vendor.test.ts) and
the [process-death control](../../sea-trial/vendor/dsh-controls.vendor.test.ts)
with each installed DSH executable:

```sh
OAR_DSH_BIN=/absolute/path/to/dsh OAR_TEST=dsh-aimock pnpm vitest run \
  sea-trial/vendor/dsh.vendor.test.ts sea-trial/vendor/dsh-controls.vendor.test.ts \
  -t 'resume restores|dies mid-turn'
```
