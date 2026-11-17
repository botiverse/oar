# DSH native skill discovery

Measured November 17, 2026 on Linux x64 with DSH 0.2.1-rc.5 (OAR's minimum),
0.2.2-rc.1 (npm `latest`) and 0.2.2-rc.3 (npm `next`). The reader exposes
`ctx.skills.snapshot({ cwd })` through OAR's existing bridge after
`loader.await()`. No agent, prompt or model request is needed.

## Observations

The isolated fixture has its own Git root, DSH home and shared agents home.
The native filesystem provider returns five fixtures: project `.dsh/skills`
and `.agents/skills`, user `$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills`, and
an explicitly configured `DSH_BUNDLED_SKILL_DIR`. The last is a test fixture
for the native bundled source, not a claim that these ACP profiles ship a
particular builtin skill. The unmodified ACP profile in the initial empty
fixture on Linux had no bundled entries. Windows CI at head `8e08da22`
also discovered the native `diagnose-windows-sandbox-acl` skill, so the test
now requires the five fixtures and compares the entire same-platform native
catalog with OAR instead of fixing the catalog size at five. The failed run
was [44014501905, job 133809062396](https://github.com/botiverse/oar/actions/runs/44014501905/job/133809062396).

Native `source` distinguishes these roots. OAR preserves it and maps
`project-dsh`/`project-agents` to project, `user-dsh`/`user-agents` to user,
and `bundled` to builtin. The native enum defines `custom` and `runtime` as
separate categories; they map to other (source-checked, not fixture-observed).
Future sources remain unclassified. The native provider label `filesystem` is not a plugin identity,
so OAR leaves `plugin` absent. Native `invocation.modelInvocable:false` maps to
`disableModelInvocation:true`; neither invocation permission implies enabled
or active in a session. Paths come directly from the snapshot. Bodies,
resource locators and provider diagnostics are not exposed.

The native snapshot supplies `complete`. OAR maps `partial` to its inverse:
a provider throwing an error leaves the valid entries and `complete:false`;
a malformed YAML skill omitted by the native loader leaves `complete:true`.
A provider that never settles reaches the caller deadline; the reader kills
and waits for the owned process. The test records that the provider actually
entered and verifies that its process is gone before returning.

This is the global catalog of the profile OAR launches, not a live agent's
scope chain. The native API also accepts a `scope` identifying an agent;
OAR does not create an agent to select a preset, merge other profiles or claim
that their skills are present. Native plugins may contribute virtual entries
without a file path. An absent snapshot method returns unsupported; malformed
payloads and query failures return unavailable rather than an empty list.

## Costs and boundaries

Native startup creates ACP profile files and a storage directory in a cold
DSH home and activates configured plugins. The comparison preserves the
existing home patch byte for byte and records no session log, model request
or invocation of a skill. Filesystem discovery reads skill files to parse
metadata; this does not promise that bodies are never read from disk.
Configured third-party skill providers and startup plugins can perform their
own work, including network requests. OAR does not disable them, rewrite
configuration or use a guessed directory scanner. The fixture disables native
DeepSeek account/provider/upload plugins and uses only a loopback provider;
no real account is used. Default orientation does not query skills; explicit
customization reads carry the native startup costs.

The first scratch probe omitted its own Git root and selected the machine's
ancestor `/tmp` repository, so its project fixtures were absent. The permanent
fixture owns `.git` and tests the supplied cwd under that boundary. This was
fixture setup, not a native discovery failure or a product workaround.

## Reproduce

Install the selected DSH into an isolated prefix, then run from the repository:

```sh
OAR_TEST=dsh-aimock OAR_DSH_BIN=/absolute/path/to/dsh \
  OAR_TRIAL_RUN_DIR=/absolute/path/to/results \
  pnpm vitest run sea-trial/vendor/dsh-skills.vendor.test.ts
```

The [vendor suite](../../sea-trial/vendor/dsh-skills.vendor.test.ts) compares
an independent native call with the public reader and checks provider failure,
timeout, cleanup, metadata equality, configuration preservation and no model
requests. It runs in the existing DSH vendor CI jobs on the minimum version;
macOS/Windows results for this new query are pending that CI, not claimed by
the Linux measurements. The [unit suite](../../tests/dsh/skills.test.ts) adds
missing-method, malformed-response, unknown-source and invalid-deadline cases
against the actual bridge text.

All three versions passed the three native inventory cases. The minimum
version also passed all 18 applicable session behavior cases (account usage
is unsupported and skipped). The local commit gate passed typecheck, lint,
4,560 unit tests and all 18 applicable mock behavior cases.

Selected native observations and raw fingerprints are in
[catalogs.json](catalogs.json) and [raw-manifest.json](raw-manifest.json).
Native service definitions at source commit
[39163dd30f70](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738):
[`SkillRegistry.snapshot`](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/skill/skill/src/index.ts),
[filesystem discovery](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/skill/skill-filesystem/src/index.ts).
