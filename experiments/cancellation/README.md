# Input cancellation investigation

Findings and source references: [runtime cancellation report](../../docs/runtimes/input-cancellation.md).

```sh
python3 experiments/cancellation/probe.py > /tmp/cancellation-static.json
pnpm exec tsx experiments/cancellation/pi.ts > /tmp/cancellation-pi.json
```

`probe.py` invokes only CLI `--version` and Codex's offline JSON-schema generator,
then scans installed executable bytes for a fixed list of markers. Override paths
with `OAR_CODEX_BIN`, `OAR_CLAUDE_BIN`, `OAR_GROK_BIN`, `OAR_KIMI_BIN`.
Offsets of -1 mean “marker not found”, never “feature absent”. Hashes pin binary
observations. No user config/session contents or arbitrary binary excerpts are
emitted. Codex queue operations require `--experimental` in schema generation.

`pi.ts` imports the installed SDK class and calls `clearQueue` and `abort` on a
mock receiver; it creates no AgentSession, model, tool or provider connection.
Its assertions distinguish clearing from abort and preserve duplicate text.
These are method-level checks, not live cancellation/race tests.

Captured on 2026-09-16:

- [Static versions, schema properties and markers](observed-static.json)
- [Pi installed-method probe](observed-pi.json)

No model prompts, runtime servers or login flows were started. The report lists
what still needs isolated native execution before API support can be claimed.
