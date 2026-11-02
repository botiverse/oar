# Pi 1.5.0 security update: 2026-11-02

OAR base `11723ed4`, Linux x64, local scripted providers. This change upgrades
Pi Coding Agent and Pi AI from 1.4.0 to 1.5.0 and undici from 8.10.2 to
8.12.3. Pi Durable and Chord remain at 1.4.0. No real account or model quota
was used. The [selected results](pi-1.5.0/selected.json) retain versions,
original failure summaries, log digests and the separate-process resume result.
Windows and macOS results remain subject to this PR's CI.

## Security update

[Pi 1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0) pins
[undici 8.12.3](https://github.com/nodejs/undici/releases/tag/v8.12.3).
OAR adopts that exact pin too. The four tracked advisories affect 8.10.2;
all list 8.12.2 as the first patched 8.x release:

| Advisory | Issue |
| --- | --- |
| [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | TLS certificate checks can be bypassed when Agent loses supplied TLS options |
| [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | Cross-origin redirects can poison a shared cache and disclose another user's response |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | TLS 1.2 renegotiation with a changed certificate can cause denial of service |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | Excessive content encodings can cause denial of service through an unhandled error |

This verifies the installed versions against the advisories' patched ranges;
it does not reproduce the vulnerabilities or claim that every OAR host
exercises their prerequisites. There is no dependency override: the native
SDK and OAR request the same version. Their Pi AI registration target must
also be the same package instance, as required by the
[bundled-provider contract](../docs/runtimes/pi.md#http-plane-and-proxies).
The clean-install regression checks both identities before and after a host
adds the older Durable catalog.

## Durable stays on 1.4.0

The [Durable 1.5.0 changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/CHANGELOG.md)
removes `watchEvents`, changes watch callbacks and storage commits, and changes
`pi.live` to v3. Durable 1.4.0 cannot read documents written in that format.
These changes require a separate adapter and host migration; the security
update does not adopt them or write v3 documents.

OAR's optional Durable/Chord peers remain `~1.4.0`. Its Durable model catalog
type now comes directly from the native `HarnessOptions`, rather than the
newer coding SDK's Pi AI package. Hosts continue to pass their Harness's own
Pi AI 1.4.0 catalog or supplier. No cast bridges the incompatible transcript
brands and no Durable event or storage algorithm changes.

Repository-only fixtures and the demo use an npm alias for Pi AI 1.4.0 while
the coding SDK tests use 1.5.0. That alias is not a published dependency.
A new native regression runs SDK 1.5.0 and Durable 1.4.0 concurrently in the
same host, with equal provider/model names but distinct catalogs and endpoints;
each sends one request to its own endpoint and receives only its own answer.
The packed-host check compiles both direct and supplier catalogs against the
published declaration, then completes a native Durable turn with a synthetic
provider and disposes the session.

A clean npm host exposed a dependency-layout failure that pnpm's workspace
layout did not: installing Pi AI 1.4.0 under its normal name placed distinct
Pi AI 1.5.0 copies under OAR, the coding SDK and agent-core. `npm dedupe` did
not repair that layout. After OAR registered the provider modules, a
single-file bundle using the coding SDK's own `ModelRuntime.getAuth` failed:
`OAuth auth derivation failed for anthropic: Cannot find module` for
`anthropic.js`. The synthetic credential was unexpired; no OAuth endpoint
was called.

The supported installation keeps Pi AI 1.5.0 at the normal package name and
uses a version alias for the Durable 1.4.0 catalog. A plain host installing
only OAR also passes. For both shapes, `tests/clean-install.ts` now checks
that the complete tree contains only one coding-SDK Pi AI version instance,
that OAR and the SDK share it and undici, and that a single-file bundle can
derive auth through the SDK after OAR's module registration. Durable's
separate older catalog completes a real native turn.

## Native behavior and validation

The full vendor suites exercised SDK and RPC 1.5.0 plus Durable 1.4.0. The
first run found one failure each in SDK and RPC: a test embedded the old
upstream default-prompt wording. The replacement compares an unconfigured
session's current native prompt with an empty-append session, and verifies
replacement does not inherit that prompt. The empty replacement still fails
before any provider request. All three corrected cases pass in both backends;
custom nonempty replacement remains covered by the existing prompt tests.

| Backend | Native controls | Shared behavior cases |
| --- | --- | --- |
| Pi SDK 1.5.0 | 89 passed | 17 passed, 2 inapplicable |
| Pi RPC 1.5.0 | 87 passed | 17 passed, 2 inapplicable |
| Pi Durable 1.4.0 | 25 passed, including coexistence | 18 passed, 1 inapplicable |

The final complete run of all three native suites passed. The full local gate
also passed 2,991 tests and 18 mock behavior cases; build and clean packed
installation passed. The RPC executable-version fixture now follows the 1.5.0
pin and rejects both the older 1.4.0 and untested 1.6.0 commands.

The suites cover provider requests, tools, extensions, MCP, controls and
resume prompt behavior. The bundled-provider tests also exercise the provider
registration used by packed hosts. They do not validate real-service auth,
every changed native default model, or arbitrary host extensions.

The existing upgrade probe created a session with SDK 1.4.0, then resumed it
in a separate process with 1.5.0. Native id, saved model and prior user and
assistant messages survived; the new OAR record stream began at sequence zero.
This checks conversation continuity, not recovery of unfinished execution.

Reproduce with installed dependencies and an older checkout using Pi 1.4.0:

```sh
CI=1 pnpm run check
pnpm run build
pnpm run clean-install
OAR_TEST_REQUIRE_AVAILABLE=1 pnpm tsx sea-trial/all.ts pi-aimock pi-rpc-aimock pi-durable-aimock
OAR_TEST=pi-aimock pnpm vitest run sea-trial/vendor
OAR_TEST=pi-rpc-aimock pnpm vitest run sea-trial/vendor
OAR_TEST=pi-durable-aimock pnpm vitest run sea-trial/vendor
pnpm tsx experiments/pi-upgrade-resume.ts <older-oar-checkout>
```

## Release-note draft

Update the bundled Pi Coding Agent/Pi AI to 1.5.0 and their shared undici to
8.12.3, including fixes for the four advisories above. Hosts using their own
bundler should keep OAR and the coding SDK on the same Pi AI and undici copies.

Pi 1.5.0 changes its native default system prompt, so sessions that omit
`systemPrompt` can behave differently. Pass your own `systemPrompt` to keep
its wording fixed. Hosts selecting a custom Pi RPC executable must also use
1.5.0, matching the bundled SDK; the default RPC launch already uses that SDK.
Other upstream catalog and provider changes are documented
in the native release; this update retains native defaults.

Pi Durable and Chord remain on 1.4.0. Hosts using this optional adapter must
keep its catalog on 1.4.0 through an alias while the coding SDK uses 1.5.0:

```json
{
  "dependencies": {
    "@botiverse/oar": "^0.85.1",
    "@earendil-works/pi-ai": "1.5.0",
    "@earendil-works/pi-ai-durable": "npm:@earendil-works/pi-ai@1.4.0",
    "@earendil-works/pi-durable": "~1.4.0",
    "@earendil-works/chord": "~1.4.0"
  }
}
```

Update imports that construct the Durable catalog, providers and schemas to
use `@earendil-works/pi-ai-durable` and its subpaths, for example:

```ts
import { createModels } from "@earendil-works/pi-ai-durable/models";
```

Installing 1.4.0 under the normal Pi AI name instead can create duplicate
1.5.0 instances and cause `OAuth auth derivation failed ... Cannot find module`
in a single-file host. Hosts without Durable only need the OAR update.
No Durable storage migration is part of this patch. Durable 1.5.0 support is
a separate minor release with migration instructions.
