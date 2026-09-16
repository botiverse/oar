# Native inventory probes

Findings: [skills, MCP and tools](../../docs/runtimes/inventory.md).
Observed locally on 2026-09-16; sanitized JSONL snapshots are in [observed/](observed/).

Run from the OAR root with installed CLIs and the Pi SDK dependency:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 experiments/inventory/probe.py all /absolute/workspace
# Or one of: codex, claude, grok, kimi, pi
node experiments/inventory/pi.mjs /absolute/workspace /absolute/sdk/package-directory
python3 experiments/inventory/replay_claude.py /path/to/existing/trace.jsonl
```

Binary overrides: OAR_CODEX_BIN, OAR_CLAUDE_BIN, OAR_GROK_BIN, OAR_KIMI_BIN.
Pi defaults to this repository's resolved SDK; the optional package directory
lets the same helper probe a consumer's installed version.

The probes send no model prompts or tools/call requests. They use native
discovery operations; runtime startup may load extensions and connect configured
MCP servers. Grok and Kimi create their own empty sessions and delete those
sessions through native APIs. Kimi's server retains token authentication and
binds only loopback; its startup token never leaves process memory. Native
workspace/session bookkeeping can still be updated. Existing user sessions and
configuration are not intentionally modified. No trust or permission grant is
sent.

Output contains field names, counts, approved state enums and versions; never
raw server configs, environment values, credentials, skill contents or history.
Negative exploratory queries are recorded as rejections, not universal proof of
absence. Successful empty MCP lists cannot validate nonempty response shapes.
Count changes across versions, workspaces, startup timing and configuration are
expected.

The replay helper reads an existing trace without running the model and emits
only version and inventory counts/item types. The checked-in replay is from
Claude 2.1.272, while the fresh control-protocol probe is 2.1.273.
