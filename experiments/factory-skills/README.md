# Factory skill metadata without a session

On Linux x64, Factory Droid 1.12.1 (protocol 1.340.0) and 1.13.0
(protocol 1.350.0) answer `droid.list_skills { includeContent: false }`
before session initialization, without an account. The same process returns
the same catalog after `droid.initialize_session`. OAR uses the direct native
query, not the SDK's session-required wrapper and not directory reconstruction.

The native comparison is retained in
[`factory-skills.vendor.test.ts`](../../sea-trial/vendor/factory-skills.vendor.test.ts).
It runs in the existing Linux/macOS Factory CI jobs; this report's local
observations are Linux only. Both versions passed locally.

| Observation | 1.12.1 | 1.13.0 |
|---|---:|---:|
| Native entries, four synthetic skills plus builtins | 25 | 26 |
| Pre-initialization catalog equals post-initialization | yes | yes |
| Query omits content and resource bodies | yes | yes |
| OAR preserves disabled user skill and hidden project skill | yes | yes |
| Local model-provider requests during query and empty initialization | 0 | 0 |
| Query leaves settings unchanged and creates no session file | yes | yes |

`location: personal/project/builtin/automation` becomes shared
`scope: user/project/builtin/other`, with the native location retained as
`source`. The optional `pluginId` is the plugin identity, independent of scope.
Unknown categories have no shared scope. `enabled` is copied, including false
from Factory's disabled-skills ledger. A skill with `userInvocable: false`
still appears. That flag is not `disableModelInvocation`; the latter is left
unknown even when a fixture has that frontmatter, because this native answer
does not report it. OAR requests no bodies and publishes only metadata.

A valid empty list is complete. Native `projectAvailable: false` explicitly
marks the result partial. Absence of that optional field is not a known gap.
Malformed answers fail, method-not-found is unsupported, and raw errors are
not exposed. OAR closes and awaits its query process on success, failure and
timeout. No session, prompt or tool invocation is sent by the reader.

## Startup effects and limits

No model request does not mean no network. A separate query-only 1.13.0
control traced outbound DNS and HTTPS connections. It created native host,
log, telemetry, state and certificate-cache files, and extracted a bundled
skill. It created no session files or credential store. These are observed
startup effects, not a promise that every installation writes the same files.
`orient({ include: ["customization"] })` is an optional native read and does
not have default local depth's no-network guarantee.

The selected result is in [result.json](result.json). Raw wire output,
connection traces and file lists stay local; no account was used. The query
reports Factory's effective catalog, not every file or shadowed definition.
There is no native per-file error list here. OAR does not claim to detect
malformed files the native loader silently omits. Plugin and automation field
mapping follows the exported schema and unit fixtures; this run did not
install a third-party plugin or run an automation.

## Reproduce

Install the desired official `droid` package, then from the repository root:

```sh
OAR_FACTORY_BIN=/absolute/path/to/droid OAR_TEST=factory-aimock \
  OAR_TEST_REQUIRE_AVAILABLE=1 pnpm vitest run sea-trial/vendor/factory-skills.vendor.test.ts
python3 experiments/factory-skills/probe.py /absolute/path/to/droid /tmp/factory-skills --trace
```

The native test supplies an isolated HOME, synthetic fixtures and a local
provider. The Python Linux control preserves its isolated HOME and raw output
under the output directory, never sends a session or model request, and uses
`strace` only with `--trace`. Startup can access external services in either
case. Inspect raw output before sharing it.

Primary interfaces: [Factory TypeScript SDK](https://docs.factory.com/sdk/typescript),
[skills](https://docs.factory.com/harness/skills) and
[CLI reference](https://docs.factory.com/droid-cli/cli-reference).
The installed official `@factory/droid-sdk` exports `ListSkillsRequestParamsSchema`,
`SkillInfoSchema` and `ListSkillsResultSchema`; its `listSkills()` method sends
`droid.list_skills` after a client-side session check. The direct protocol
measurement establishes that this check is unnecessary for inventory reads.
