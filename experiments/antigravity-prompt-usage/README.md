# Antigravity 1.5.12 quota and token accounting

On 2026-11-19 a real Gemini session on Linux emitted exactly one assistant
notice (including the leading and trailing newline), followed by a successful
prompt response. No tool, thought, usage update, error code or metadata
accompanied the notice.

```json
{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h30m42s.\n"}}
{"stopReason":"end_turn"}
```

Fifteen other prompt responses across the seven captured sessions had a
usage ledger. In all fifteen, total equalled input plus output plus cache
reads. The largest cache reads spanned multiple model calls in one turn.
One response reported:

```json
{"inputTokens":192984,"outputTokens":50553,"cachedReadTokens":1559852,"cachedWriteTokens":0,"thoughtTokens":39843,"totalTokens":1803389}
```

The OAR input for that turn is 1,752,836. Fourteen replies had nonzero
thought tokens, always within output. All fifteen reported zero cache
writes. A session that ended before its prompt response supplied no ledger.

## Local provider control

Run the [probe](probe.ts) with an installed agy 1.5.12:

```sh
pnpm exec tsx experiments/antigravity-prompt-usage/probe.ts "$(command -v agy)"
```

The probe uses three prompts in the same isolated session against a loopback
Gemini provider. Each model reply carries 100 prompt tokens (20 cached),
5 candidate tokens and 3 thought tokens, for a total of 108. The first two native
prompt responses report the following ledger:

```json
{"inputTokens":80,"outputTokens":8,"cachedReadTokens":20,"cachedWriteTokens":0,"thoughtTokens":3,"totalTokens":108}
```

The repeated 108 rules out a session-lifetime counter. The 8 output
tokens include the 3 thoughts. On the second prompt the provider also
injected synthetic `cachedWriteTokens: 11` and `cacheCreationInputTokens: 11`
into Gemini usage metadata. Neither reached ACP. The treatment of genuine
nonzero cache writes remains unknown.

The third prompt runs an echo tool between two provider calls. Each call
reports the same 108 tokens. The single native prompt response reports
216 total, 160 input, 40 cached reads, 16 output and 6 thoughts. This
distinguishes the whole-turn ledger from the final model call alone.

[ACP replay tests](../../tests/acp/acp-antigravity-quota.test.ts) exercise
the live quota notice and spend sample, normal quoted output, tool and
reasoning activity, and a synthetic RPC error carrying the notice in its
data. The RPC error envelope for an actual account refusal was unavailable.
