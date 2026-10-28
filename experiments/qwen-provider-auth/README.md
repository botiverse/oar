# Qwen native provider setup

Qwen 0.26.2 exposes `qwen/providers/list` and `qwen/providers/connect` on
ACP. These probes use the installed CLI directly, isolated HOME/workspace
directories, synthetic keys and a loopback endpoint. They do not open a
conversation, prompt a model or use a real account.

```sh
pnpm tsx experiments/qwen-provider-auth/probe.ts /path/to/qwen/cli-entry.js oar-trial-run/qwen-provider-coverage
pnpm tsx experiments/qwen-provider-auth/connect.ts /path/to/qwen/cli-entry.js oar-trial-run/qwen-provider-connect
```

Use a fresh output directory for each run. The directories contain synthetic
credential fixtures and are deliberately retained for inspection. Each script
writes `observations.json`; the coverage probe also saves the native provider
menu in `providers.json`. An optional final coverage argument selects one
cell by name. Serial runs avoid conflating metadata behavior with cold-start
contention. Native exceptions are evidence, not automatically retried.

## Observed on Linux, 2026-10-28

Package `@qwen-code/qwen-code@0.26.2`, source commit
[`40291114`](https://github.com/QwenLM/qwen-code/tree/402911146f6b2a80cb97423309faf1956f6defe4).
[Retained observations](evidence.json) contain no credential values.

| Synthetic source | DeepSeek `existingConfig` |
| --- | --- |
| Empty HOME | Absent |
| Process `DEEPSEEK_API_KEY` | Absent |
| HOME `.env` | Absent |
| User `settings.env` | Present, `hasApiKey: true` |
| System `settings.env` | Present, `hasApiKey: true` |
| Workspace `settings.env`, launched in that workspace | Present, `hasApiKey: true` |
| Same workspace settings, launched outside it | Absent |
| Workspace `.env` | Absent |
| User `security.auth.apiKey` | Absent |
| Native-owned DeepSeek model configuration without a key | Present with `modelIds`, without `hasApiKey` |

The first exploratory fixtures used `OPENAI_API_KEY`, but the native menu
has no OpenAI preset. They were replaced with DeepSeek's own preset key.
An initial model-only fixture also lacked Qwen's `[DeepSeek] ` name prefix
and was not attributed to that provider. Adding the native ownership name
made that control report the model without claiming a key. Neither result
establishes credential validity or invalidity.

`readExistingProviderConfig` and `readSettingsEnv` in
[`acpAgent.ts`](https://github.com/QwenLM/qwen-code/blob/402911146f6b2a80cb97423309faf1956f6defe4/packages/cli/src/acp-integration/acpAgent.ts)
read merged settings, not process environment. `resolveOwnsModel` in
[`provider-config.ts`](https://github.com/QwenLM/qwen-code/blob/402911146f6b2a80cb97423309faf1956f6defe4/packages/core/src/providers/provider-config.ts)
explains the model fixture's name-prefix requirement. These are settings
menu facts, so OAR retains its separate local `authStatus` observation.

For a custom OpenAI-compatible provider, `connect` and a reconnect omitting
the key both succeeded. Explicit `user` scope wrote only the user's settings;
`workspace` wrote only the workspace's settings. Omitted scope wrote to user
settings in this probe, not as an OAR guarantee. The native list returned
`hasApiKey`, model ids and base URL without the key. The facade's vendor test
also verifies key reuse after killing the original reader and starting a new
one. All loopback endpoints received **zero HTTP requests**; they would have
returned 401. Configuration success therefore does not prove authentication.

Unknown provider and invalid scope returned ACP `RequestError` code `-32602`.
After initialize, replacing the synthetic user's settings-file path with a
directory made connect return `-32603`, with native details `EISDIR: illegal
operation on a directory, read`. A subsequent reconnect without a key failed
with `-32602`. This early filesystem failure is not evidence that every later
failure rolls back writes. Native
[`applyProviderInstallPlan`](https://github.com/QwenLM/qwen-code/blob/402911146f6b2a80cb97423309faf1956f6defe4/packages/core/src/providers/install.ts)
attempts rollback, but OAR cannot promise it after process loss or timeout.

OAR keeps the native numeric error code and omits native error text/data/cause.
The error could contain a previously stored key that the facade never read.
Native stderr is suppressed and response envelopes are filtered before the
ACP SDK's own diagnostic logging. Only matching responses enter the SDK;
unsolicited messages do not establish provider state. Unit tests cover secret
output, time budgets, failed launches, malformed result payloads and no retry
of a write whose answer was lost. The native regressions are
`sea-trial/vendor/qwen-provider-auth.vendor.test.ts`, run with
`OAR_TEST=qwen-aimock pnpm vitest run sea-trial/vendor/qwen-provider-auth.vendor.test.ts`.

The native observations above are Linux evidence. The new vendor regressions
run in the existing Qwen CI backend on Linux, macOS and Windows; consult that
PR's results for platform verification. No claim is made about OAuth, logout,
paid provider acceptance or transactional writes after an interrupted process.
