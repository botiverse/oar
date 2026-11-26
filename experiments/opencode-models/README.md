# OpenCode v2 model discovery

On November 25, 2026, OAR returned only model IDs on Linux with OpenCode
2.1.4, 2.2.7 and 2.4.1. OpenCode's `models --help` offers `--standalone`
to isolate the server. Its
[command handler](https://github.com/anomalyco/opencode/blob/ea8aa5b05ef49af86d6c78dad0a19e2877e034e0/packages/cli/src/commands/handlers/models.ts)
reads the native [model.list API](https://github.com/anomalyco/opencode/blob/ea8aa5b05ef49af86d6c78dad0a19e2877e034e0/packages/protocol/src/groups/model.ts)
and prints only sorted provider/model IDs. The
[ACP adapter](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/cli/src/acp/config-option.ts)
builds its effort menu from each model's variant IDs.

Each entry below used a separate fresh home and project with two synthetic
provider models. The CLI columns count catalog entries. The HTTP column
used one private loopback server, polled `GET /api/plugin` for initial
rows, then read `GET /api/model` in the same project.

| OpenCode | models --standalone | api model.list --standalone | Private HTTP |
| --- | ---: | ---: | ---: |
| 2.0.26 | 0 | 0 | 13 |
| 2.1.4 (issue reporter's version) | 11 | 11 | 11 |
| 2.2.7 (CI pin) | 14 | 14 | 14 |
| 2.4.1 | 13 | 0 | 13 |

All four private servers returned the configured `Reasoner` model with
variant IDs `low`, `high` and `default`, plus a second model with only
`default`. Each server left zero rows in `session_v2`, the original project
configuration bytes and a closed listener after teardown. With the
[native standalone transport](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/cli/src/services/standalone.ts),
`serve --stdio` reported its loopback URL as JSON and exited when its
stdin pipe closed on all four versions. The native
one-shot CLI [waits for initial plugins](https://github.com/anomalyco/opencode/blob/v2.4.1/packages/cli/src/services/plugin-startup.ts)
at 25 ms intervals for up to five seconds. On 2.4.0+,
[later package plugins](../opencode-skills/activation-2.4.1.md) can still
contribute after this initial snapshot.

On 2.4.1 a separate 64-model project returned all 64 labels and menus in
one HTTP model request. Holding that request until the caller's 3000 ms
deadline raised `TimeoutError`. Both runs left zero sessions, the same
default-model configuration and a closed listener.

Run the [regression](../../sea-trial/vendor/opencode-models.vendor.test.ts)
against an installed v2 executable. It checks three distinct project
menus, the saved default, the project configuration and the session count.

```sh
OAR_TEST=opencode-aimock OAR_OPENCODE_BIN=/path/to/opencode \
  pnpm vitest run sea-trial/vendor/opencode-models.vendor.test.ts
```
