# Qoder ModelProvider confirmation: 2026-11-05

Qoder 1.1.82 changed the native name source, so explicit model selection could
fail before a prompt even though the selector existed. OAR now uses the same
stable-version decision for the launch protocol and catalog confirmation.
This fixes model confirmation only. Required execution CI remains pinned to
1.1.81 because native replay is independently unavailable in 1.1.82 and 1.1.83.

## Native basis and boundary

The published 1.1.82 bundle uses `getModel(snapshot.model).displayName` for
`system/init.model`. `daemon.get_models` projects the same ModelProvider
descriptor as `value`, `modelId` and `displayName`, without `serverModel`.
The [source investigation and selected hashes](https://raft-artifacts.com/p/open-agent-runtime/qoder-1-1-82-native-compatibility)
retain the inspected packages and the separate replay controls. The
[November 4 observations](https://github.com/botiverse/oar/blob/8f553bde2569cf1189088d5fb07e71b3f4092f64/experiments/runtime-version-checks/2026-11-04.md#qoder-1183)
show the same catalog shape in 1.1.83. Its replay failure reports HTTP 500
without the 10500 field from 1.1.82; these are separate observed error shapes,
not a diagnosis of the provider.

The new mapping requires exactly one matching selector, `modelId` equal to
that selector, and a nonempty `displayName` unique in the full catalog,
including disabled rows. Init must equal that name exactly. A duplicate name
cannot distinguish two selectors, even if init happens to equal the requested
selector. Through 1.1.81, a differing init name still requires the old
`serverModel.display_name`; a display label is not a fallback on that path.
`listModels()` uses the same verified mapping for `resolvedId`.

When installation metadata has no version, launch probes `--version` in the
session environment once. Its parsed stable version chooses both `--sdk`
(from 1.1.81) and the ModelProvider mapping (from 1.1.82), and travels with the
owned transport. An unreadable or non-stable version refuses before launch.
The standalone `projectQoderModels(payload)` helper keeps its old projection
when no version argument is supplied; runtime listing always supplies the
resolved launch version.

## Controls

The [native regression](../../sea-trial/vendor/qoder-models.vendor.test.ts)
opens an isolated synthetic-identity session with `model: "efficient"`, reads
the actual live catalog, and compares init with the selected native row.
On the provider path it independently asserts wire `modelId === "efficient"`
and uniqueness of the display name. It then opens through the public session
adapter with version metadata omitted and verifies the same readback. Neither
path submits a user message or invokes inference.

On Linux x64, the controls pass with native 1.1.81, 1.1.82 and 1.1.83. The
two newer versions report `value: "efficient"`, `modelId: "efficient"`,
`displayName: "Efficient"` and `system/init.model: "Efficient"`.
The complete native behavior and vendor suites remain the execution controls
for 1.1.81. No execution-success claim is made for 1.1.82 or 1.1.83.

Bugen independently checked an existing Free account on 1.1.83, with native
`daemon.get_models`, `daemon.open_session` and session `initialize` only.
All 15 display names were unique. The only enabled entry had
`value: "qfmodel"`, `modelId: "qfmodel"`, `displayName: "Qwen3.8-Flash"`;
init reported `Qwen3.8-Flash`. No user message, model inference, account
identifier or credential was part of the shared evidence.

Unit regressions cover missing and conflicting fields, duplicate names
(including disabled rows), duplicate selectors, direct-init bypass, one live
fallback, private catalog responses, the legacy boundary and missing version
metadata. Their fixtures intentionally separate UI labels from native names.
Six semantic counterexamples fail when selector/modelId equality, name
uniqueness, the 1.1.81 boundary, direct-init validation, resolved launch-version
propagation or listing-version propagation is removed. The restored Qoder
unit suite passes all 96 cases. The full check passes 3,160 tests and 18 mock
behavior cases; native 1.1.81 passes 17 behavior cases and all 13 vendor cases.

Reproduce the model control with any of the three exact native executables:

```sh
OAR_QODER_BIN=/absolute/path/to/qodercli OAR_TEST=qoder-native \
  OAR_TEST_REQUIRE_AVAILABLE=1 pnpm vitest run sea-trial/vendor/qoder-models.vendor.test.ts
pnpm vitest run tests/qoder
```

The fixture can perform native catalog or startup network I/O. It uses a
synthetic identity in its own HOME and does not use the operator's login.
