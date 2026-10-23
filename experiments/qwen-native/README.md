# Qwen stream-json probe

Run the native binary directly against a local OpenAI-compatible scripted
provider, without OAR's adapter or an account:

```sh
pnpm tsx experiments/qwen-native/probe.ts /path/to/qwen /tmp/qwen-evidence plain
pnpm tsx experiments/qwen-native/probe.ts /path/to/qwen /tmp/qwen-mcp tools
pnpm tsx experiments/qwen-native/probe.ts /path/to/qwen /tmp/qwen-permission permission
pnpm tsx experiments/qwen-native/probe.ts /path/to/qwen /tmp/qwen-catalog catalog
```

The permission scenario deliberately uses native default approval to obtain a
`can_use_tool` request. The adapter always uses yolo. Each run creates an isolated
HOME and project; the evidence directory contains both directions of the wire,
stderr, provider requests and query results. It preserves temporary native state
for inspection; remove the reported temporary root after inspection.

Observed 2026-10-23 on npm 0.26.0, published source
ac97ce7a70d9b2ea5d62b357e3d9b0851423afc9:

- Initialize must be the first stdin frame. Its success precedes completion of
  extension/MCP initialization, so it is not a readiness barrier.
- Every turn reports model init and result; no command_lifecycle arrives.
- Results accumulate session token totals, including restored history and
  auxiliary calls. Neither global get_usage_info nor get_context_usage is a
  session-spend baseline for resume.
- `effort_status` reports whether an explicitly requested effort was applied.
  No effort is assumed from the request alone.
- MCP stdio calls and the native allow/updatedInput permission response work;
  interrupt settles the active turn, and another prompt can run afterward.
- A native modelProviders configuration appears in get_available_models;
  environment-only configuration can return an empty list.

[evidence.json](evidence.json) retains a small observation from the initial
behavior run's extension-lock failure. The machine-local full trace also includes
the development failures that led to this fix. It is not a successful test run.
The [runtime page](../../docs/runtimes/qwen.md) and native vendor suite preserve
these limits and verification boundaries.
