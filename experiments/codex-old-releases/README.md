# What older Codex releases refuse at open

codex-cli from npm (`@openai/codex@<version>`), Linux arm64, 2026-11-11.
Raw `codex app-server` JSON-RPC over stdio with a scratch `CODEX_HOME` and a
fake API key: no login, and no request reaches a model. The turn/start
refusal classes are read from the 0.167.0 source
(`codex-rs/app-server/src/request_processors/turn_processor.rs`,
`error_code.rs`, `config_errors.rs`, `config_manager.rs`).

```sh
pnpm tsx experiments/codex-old-releases/probe.ts <codex-binary>
pnpm tsx experiments/codex-old-releases/probe.ts <codex-binary> bad-config
```

## Results

| Version | `serviceTier: "default"` / `"priority"` on thread/start | `flex` | `fast` | `thread/settings/update` |
| --- | --- | --- | --- | --- |
| 0.118.0, 0.125.0, 0.128.0 | -32600 `Invalid request: unknown variant \`default\`, expected \`fast\` or \`flex\`` (and the same for `priority`) | `flex` | `fast` | -32600 `Invalid request: unknown variant \`thread/settings/update\`, expected one of ...` |
| 0.129.0, 0.130.0, 0.132.0 | echoed as given | `flex` | `priority` | the same -32600 |
| 0.133.0, 0.134.0, 0.135.0 | echoed as given | `null` | `priority` | `{}`, then `thread/settings/updated` |

Every release reports `serviceTier` in the thread/start reply (`null` with no
tier). `initialize` answers `userAgent: "oar/<version> (<os>; <arch>) ..."`
on all of them, the client name first. `turn/start` on an unknown thread is
-32600 `thread not found: <id>` on all of them.

With an unparsable `config.toml`, 0.118.0 and 0.154.0 both start (stderr:
`Invalid configuration; using defaults. <path>:3:9: ...`), answer
`initialize`, and refuse thread/start with -32600 `failed to load
configuration: <path>:3:9: unclosed array table, expected \`]]\``. 0.118.0
with `service_tier = "nonsense-tier"` in the file instead starts the same way
and then refuses the requested tier as above.

OAR's reading of these is in [codex refusals](../../docs/runtimes/codex.md#refusals).
