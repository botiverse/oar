# Pi 1.5.2 native compatibility: 2026-11-10

Pi SDK and RPC 1.5.2 passed the existing native behavior and vendor suites on
Linux x64. A host-owned Durable 1.4.0 catalog still coexists with the new SDK,
and a completed 1.5.0 conversation resumes in a separate 1.5.2 process with
its native identity, model and history intact.

This is a compatibility probe against OAR `c0f258d8`, with the two Pi
dependencies temporarily selected at 1.5.2 in an isolated checkout. The
committed workspace lock remains on 1.5.0. The only test change makes the
default RPC executable's expected error text use the installed SDK version.
No adapter behavior or public interface changed.

## Environment and results

Node 24.19.0, pnpm 11.22.0, Linux x64. All model responses were scripted
locally; no account login or paid provider was used. Both OAR and the coding
SDK resolved the same Pi AI 1.5.2 instance and the same undici 8.12.3 instance.
Durable, Chord and the aliased Durable Pi AI remained at 1.4.0. The selected
evidence is in [the accompanying JSON](pi-1.5.2-2026-11-10.json).

| Check | Result |
| --- | --- |
| SDK vendor suite, `pi-aimock` | 119 passed, 332 inapplicable cases skipped |
| RPC vendor suite, `pi-rpc-aimock` | 113 passed, 338 inapplicable cases skipped |
| Durable vendor suite, `pi-durable-aimock` | 26 passed, 425 inapplicable cases skipped |
| SDK behavior suite | 17 passed, 2 inapplicable cases skipped |
| RPC behavior suite | 17 passed, 2 inapplicable cases skipped |
| Durable behavior suite | 18 passed, 1 inapplicable case skipped |
| Native 1.5.0 to 1.5.2 resume | Same native id and model; prior user and assistant transcript sent; new record stream starts at sequence zero |
| RPC launch unit tests with corrected expectation | 16 passed on both 1.5.0 and 1.5.2 |
| Full repository check with the corrected test | 3,802 tests passed on both 1.5.0 and 1.5.2; typecheck, lint and mock behavior passed |
| Two package builds and mock behavior | Passed; mock 18 passed, 1 inapplicable case skipped |

The Durable vendor set includes
[`pi-durable-coexistence.vendor.test.ts`](../sea-trial/vendor/pi-durable-coexistence.vendor.test.ts):
simultaneous SDK and Durable sessions use separate native catalogs with the
same provider/model names and return their own scripted answers. It does not
upgrade Durable or migrate its storage. The resume probe checks a completed
conversation, not recovery of unfinished execution. These 1.5.2 results are
Linux observations; they do not establish Windows or macOS coverage.

## Failures retained and test correction

The first full check with the new dependencies had 3,800 passing tests and
two failures in `tests/pi/pi-rpc-launch.test.ts`. Both expected the literal
version `1.5.0` in an otherwise correct `invalid_request` refusal. The native
dependency was 1.5.2, and the product correctly named that version.

The test now reads the installed coding SDK package metadata and still
compares the entire error message and failure category. Its mismatched
executables report `0.0.0` or the next major version, so both remain distinct
from the installed SDK as it moves forward. The independent assertion that
Pi AI's source version constant matches the installed coding SDK remains.

The separate clean-install failure was also reproduced unchanged: after the
Durable host installation, the host had Pi AI 1.5.0, while coding SDK 1.5.2
resolved a nested Pi AI 1.5.2. The bare OAR host had passed the same instance
check. [PR #715](https://github.com/botiverse/oar/pull/715) handles that test's
host-version selection; this report does not claim its fix or weaken its
instance assertions.

## Native changes to keep in view

The [upstream 1.5.1 and 1.5.2 coding SDK notes](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md)
include new CLI authentication commands, changed default models, idle cache
warming and interactive handling of sessions whose original directory is
gone. The [Pi AI notes](https://github.com/earendil-works/pi/blob/v1.5.2/packages/ai/CHANGELOG.md)
describe Anthropic continuation requests and omission of an empty tools
array for OpenAI-compatible requests with tool history. Hosts needing that
old wire shape can set the native `requiresToolsWithToolHistory` compatibility
option. The new release also updates the Anthropic OAuth client version.
These are upstream descriptions, not additional observations from a real
account. Passing scripted suites does not validate provider-side continuation
or long-idle cache warming.

## Reproduction

Use two clean checkouts of `c0f258d8`, with dependencies installed. Keep one
on the committed 1.5.0 lock for the old-session side. In the probe checkout,
select Pi AI and coding SDK 1.5.2 in the root and `packages/oar` manifests,
and change the eight Pi 1.5.0 release-age exceptions in
`pnpm-workspace.yaml` to 1.5.2. Keep Durable/Chord and their alias at 1.4.0,
and undici at 8.12.3. Run `pnpm install --no-frozen-lockfile` there.

```sh
CI=1 OAR_TEST=pi-aimock pnpm vitest run sea-trial/vendor
CI=1 OAR_TEST=pi-rpc-aimock pnpm vitest run sea-trial/vendor
CI=1 OAR_TEST=pi-durable-aimock pnpm vitest run sea-trial/vendor
CI=1 pnpm tsx sea-trial/all.ts pi-aimock pi-rpc-aimock pi-durable-aimock
CI=1 pnpm tsx experiments/pi-upgrade-resume.ts /path/to/old-checkout /tmp/pi-upgrade-evidence
CI=1 pnpm vitest run tests/pi/pi-rpc-launch.test.ts
CI=1 pnpm run check
CI=1 pnpm run build
```

On unmodified `c0f258d8`, the full check reproduces the two stale-version
expectations. Apply this report's RPC launch test correction before the final
check. The native vendor and behavior suites passed without changing their
assertions or snapshots.
