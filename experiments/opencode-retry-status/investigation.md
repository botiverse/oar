# ACP omits retry status on OpenCode 1.19.6, and cancelling a retry can return end_turn

On OpenCode 1.19.6, a prompt can wait for a provider retry without any ACP
indication of the attempt or next retry time. In an independent local control,
cancelling during that wait returned `end_turn` before the provider had
produced a successful answer. Hosts use this field to report completion.

## Cancellation during retry backoff

We used a loopback Anthropic-compatible provider and the real ACP binaries on
Linux. The provider returned one ordinary transient overload event on its
first streamed model call. Every subsequent call succeeded. No account or
quota was involved. We recorded the provider attempts, issued a second prompt
after each control, and inspected the original `session/prompt` reply.

| Control | opencode-ai 1.19.6 | @opencode/cli 2.3.2 |
| --- | --- | --- |
| Allow one retry | Retried after 2.19 s, then completed | Retried after 2.21 s, then completed |
| Cancel 450 ms after the first failure, before the next attempt | ACP returned `end_turn`; zero successful replies on that turn | ACP returned `cancelled`; zero successful replies on that turn |
| Cancel an ordinary slow successful call | ACP returned `cancelled` | ACP returned `cancelled` |
| Send another prompt afterward | Completed | Completed |

A cancellation request can also race genuine completion. The caller needs a
native cancellation outcome to distinguish those cases reliably.

## Production observation

At 08:28:48 UTC on November 19, 1.19.6 started its first model call for a new
prompt. Its log recorded a free-usage-limit stream error a second later.
The host saw no update, prompt result or RPC error for over an hour. Its
stall observer fired after 613 seconds. No cancellation was requested during
that observation. In a separate 2.3.2 session a different free model hit a
quota after a tool step and returned a typed `provider.free-limit` RPC error.
Direct HTTP errors with free-limit text also terminated in separate 1.19.6
controls. The original HTTP response, upstream headers and internal attempt
counter were unavailable. The hour-long incident remains unexplained.

## Retry status is missing on ACP

The session processor records an internal retry status with the attempt and
next retry time. The policy makes a bounded number of retries for eligible
errors, including certain free-tier errors. It honors provider-supplied retry
delays, while ordinary backoff without headers is capped at 30 seconds per
wait. The ACP event handler consumes the idle status and omits retry updates.
The prompt response maps `MessageAbortedError` to `cancelled` and missing
assistant errors to `end_turn`. This explains why a host cannot see a retry,
but does not establish which retry decision the production session made.

[Retry policy](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/retry.ts),
[session processor](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/processor.ts),
[ACP event handler](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/event.ts),
[ACP prompt response](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/service.ts).
