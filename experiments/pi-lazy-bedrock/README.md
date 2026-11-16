# Pi lazy Bedrock registration

On Linux, November 16, 2026, OAR's Pi setup was changed to register Pi AI
1.5.2's lazy Bedrock loader. Opening a native Pi session and querying provider
auth no longer evaluate the Bedrock implementation or AWS SDK. A single-file
host still loads the implementation when its first Bedrock request starts.
The normal coding SDK and Pi AI dependencies both move from 1.5.0 to 1.5.2;
undici remains at the native SDK's exact 8.12.3 dependency.

## Loader controls

[The fresh-process fixture](../../tests/fixtures/pi-lazy-bedrock.ts) installs
Node module-load hooks before importing OAR, opens a real SDK session against
an isolated no-inference model, then queries auth providers. It records loads
of `bedrock-converse-stream.js` and `@aws-sdk` modules. Its home, configuration
and session store are temporary; it makes no model request.

Against the previous eager registration with the same 1.5.2 dependencies,
this control fails: the Bedrock implementation and AWS Bedrock client are
loaded. The revised control records zero matching loads after session open
and zero after auth queries. This measures module evaluation, not startup
latency or resident memory. No numerical performance saving is claimed.

[The bundled request fixture](../../tests/fixtures/pi-bundled-bedrock.ts) is
built into one Node ESM file outside the repository and run without adjacent
Pi package files. It uses the actual native Bedrock API with authentication
skipped and an explicitly supplied loopback endpoint. The local server sees
one POST to `/model/probe-model/converse-stream`, containing the user text
`local probe`, and returns a deliberate HTTP 400 `ValidationException`.
The native result retains the `local-bedrock-probe` message. This proves the
first request loads the implementation and serializes a real Bedrock request;
it does not claim a successful AWS inference or validate cloud credentials.
This bundled-request control already passed the previous eager implementation.

The [two regression tests](../../tests/pi/pi-lazy-bedrock.test.ts) exercise
both fixtures. Existing partial-registration tests retain warning-once and
retry behavior; the OAuth registration code itself is unchanged. A later
failure to import the Bedrock implementation remains a native request failure,
not a session-open failure.

```sh
CI=1 pnpm exec vitest run tests/pi/pi-lazy-bedrock.test.ts tests/pi/pi-static-modules.test.ts tests/pi/pi-static-modules-partial.test.ts
```

## Packed OAuth and version controls

The [packed host check](../../tests/fixtures/pi-clean-install.ts) verifies that
OAR and the coding SDK resolve the same Pi AI and undici instances. It bundles
a host that registers OAR's OAuth table and resolves synthetic unexpired OAuth
data through the real SDK `ModelRuntime`, without sign-in or provider traffic.
The check passes both before and after adding Durable and Chord 1.5.2 plus the
`pi-ai-durable` alias of Pi AI 1.5.2. The packed native Durable faux-provider
round and browser bundle also pass.

The [SDK upgrade probe](../pi-upgrade-resume.ts) creates a session under 1.5.0,
then resumes its JSONL store in a separate 1.5.2 process. Both prompts finish;
the session id is preserved, the second provider request contains the earlier
transcript, and each OAR controller starts its own record sequence at zero.
These are isolated local-provider controls, with no real account or host store.

## Validation and retained evidence

The initial implementation passed the full type/lint gate, 4,379 unit tests
and 18 mock behavior cases. Native SDK tests passed 124 cases and native RPC
tests passed 115 cases; each backend passed 18 shared behavior cases. Both
package builds and the complete packed installation check passed. After rebasing
onto the Durable migration merge `a6206bba`, the full gate passed 4,384
unit tests and 18 mock behavior cases; Cursor 1.4.0 and the migration
retention/backup requirements are preserved.

[results.json](results.json) records the controls and fingerprints the complete
local logs and resume records. The initial eager-loader failure is retained,
as are test-harness preparation failures: typed callback handling, the native
transcript context brand and lint annotations were corrected before the
passing gate. None of those preparation failures is counted as an adapter
regression. Evidence does not include a real AWS call, a fresh OAuth login,
or a memory/latency benchmark.
