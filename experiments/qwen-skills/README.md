# Qwen workspace skill catalog

Qwen 0.27.4 on Linux, 2026-11-17. The native ACP process answers
`qwen/status/workspace/skills` after `initialize`, before any session or prompt.
The query works without credentials and returns a structured catalog, so OAR
uses it instead of parsing `/skills` or recreating Qwen's directory loader.

The [native parity test](../../sea-trial/vendor/qwen-skills.vendor.test.ts) is
also the reproduction command:

```sh
OAR_TEST=qwen-aimock OAR_QWEN_BIN=/path/to/qwen \
  pnpm vitest run sea-trial/vendor/qwen-skills.vendor.test.ts
```

It runs in the existing Qwen vendor CI jobs on Linux, macOS and Windows. The
local result here establishes Linux behavior only; the other platforms must
pass those jobs. The fixture removes inherited credentials, uses an isolated
home, and keeps a local model-request capture. Neither the direct native query
nor OAR sends `authenticate`, `session/new`, provider-connect or prompt calls.
The model capture received zero requests.

## Catalog and projection

[Selected native evidence](evidence.json) retains only the fixture rows and one
bundled row cited here. Full local results are under
`oar-trial-run/qwen-skills/catalog.json` and uploaded by vendor CI.

- Both `.qwen/skills` and `.agents/skills` user/project fixtures appear.
- A project skill replaces the same-name user skill according to Qwen's own
  precedence. OAR does not merge or deduplicate entries itself.
- A disabled skill remains present with native `status: disabled` and OAR
  `enabled: false`. User-hidden skills also remain in the catalog.
- `level` remains `source`. `bundled`, `user` and `project` map to `builtin`,
  `user` and `project`; `extension` maps to `other` and its native
  `extensionName` becomes `plugin`. Unrecognized levels have no shared scope.
  Extension identity is covered by protocol projection tests and the native
  source mapping, not an installed-extension fixture in this run.
- Native `installedPath` is preserved, not reconstructed. Path assertions use
  canonical filesystem paths. `modelInvocable` is inverted into
  `disableModelInvocation`; the shared contract has no user-invocation field.
- Bodies and other native fields are omitted. Native uninitialized catalogs,
  malformed envelopes/entries and failed requests return `query_failed`, never
  an empty success. A missing method returns `native_query_unavailable`.
- An initialized catalog with native `errors` is partial. A complete empty
  catalog is successful and not partial. OAR does not infer completeness from
  filesystem contents that the native loader chose to omit.

## Native startup effects

This is a metadata query, not a promise of no filesystem or network activity.
The first ACP startup migrated the fixture's older settings to schema version
4, including formatting the file. It also created native installation/language
metadata, extension-enablement state, extension-store state and directories.
The following OAR query preserved that migrated settings file and all fixture
skill bodies. No session transcript was created in this fixture.

OAR does not edit settings itself or add authentication flags. Native bootstrap
owns settings migration, extension resolution and other startup behavior. The
fixture blocks outbound proxy traffic and observes no model requests; it does
not establish a general network-free guarantee. `orient()` invokes this reader
only when the host explicitly asks for customization inventories, whose
contract allows native startup work even at local depth.

Source checked at Qwen
[`f35dde84157f992bc324c0a3f59b1119344a683d`](https://github.com/QwenLM/qwen-code/tree/f35dde84157f992bc324c0a3f59b1119344a683d):
[`acpAgent.ts`](https://github.com/QwenLM/qwen-code/blob/f35dde84157f992bc324c0a3f59b1119344a683d/packages/cli/src/acp-integration/acpAgent.ts)
initializes bootstrap with LLM initialization and MCP discovery skipped, then
projects the cached native SkillManager catalog;
[`workspace-skills-mapping.ts`](https://github.com/QwenLM/qwen-code/blob/f35dde84157f992bc324c0a3f59b1119344a683d/packages/cli/src/runtime/workspace-skills-mapping.ts)
defines status, provenance and invocation metadata. The public native
[skills documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/)
describes loading and precedence.
