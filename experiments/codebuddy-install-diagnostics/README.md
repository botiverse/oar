# CodeBuddy npm installation diagnostics

Three Windows first-install failures on 2026-11-06 reached OAR's 180-second
installer deadline with no npm output. Their cause is unknown. The smoke
fixture then removed its isolated HOME, including npm's debug logs, so those
runs cannot distinguish fetching, unpacking or a lifecycle script that did
not return. A later successful retry is not a causal fix.

| Pull request | First failing job | Retained installer result |
| --- | --- | --- |
| #668 | [127939166556](https://github.com/botiverse/oar/actions/runs/42231767928/job/127939166556) | `failed`, null exit code, only the 180000 ms deadline marker |
| #672 | [127993410160](https://github.com/botiverse/oar/actions/runs/42247486997/job/127993410160) | Same |
| #674 | [128044700159](https://github.com/botiverse/oar/actions/runs/42262179295/job/128044700159) | Same |

## What changes

The [installation smoke](../../tests/codebuddy/install-smoke.ts) now enables
npm verbose and timing output only inside its isolated child environment.
It records discovery, installation, version/idempotence verification and
cleanup phases. Before deleting HOME, its parent saves the latest ten npm
debug/timing files, at most the last 1 MiB of each, marking truncation. It
also saves the collected child output and installation result. Collection
errors do not replace the installation's original error. npm tokens,
recognizable token shapes and URL userinfo are redacted; the fixture does
not copy npmrc, package contents or the rest of HOME.

The `codebuddy-install-<OS>` CI artifact uploads after success or failure.
The package selection, install command, assertions, 180-second installer
limit, 240-second child limit and cleanup retry settings are unchanged.
No retry is added and no product code changes. Verbose logging can affect
runtime cost, so a passing instrumented run alone does not establish a fix.

npm documents [debug logs and log levels](https://docs.npmjs.com/cli/v11/using-npm/logging/)
and [timing files](https://docs.npmjs.com/cli/v11/using-npm/config/#timing).
A killed process need not flush a timing file or all buffered debug output.
Missing files or the last recorded stage identify the available evidence,
not necessarily the operation that caused the timeout. The next Windows
failure should be investigated from these artifacts before choosing a fix.

## Validation

The real official npm installation passed on Linux x64 with Node 24.19.0
and CodeBuddy 2.181.0. Both native version verification and the idempotent
second install passed with the global bin directory off PATH. Selected
results are in [linux-control.json](linux-control.json). This control
establishes that instrumentation preserves the smoke's behavior on that
machine; it does not explain the Windows failures.

Focused tests cover partial debug-log retention before HOME deletion,
original failure preservation, missing logs, bounded tails and redaction.
The original discovery and installation assertions remain intact. The full
commit gate passed (3,645 unit tests and 18 mock behavior cases), as did the
package builds. Windows
and macOS instrumentation results are pending the pull request CI.

To repeat the real install (public npm download, isolated HOME and prefix):

```sh
OAR_TEST=codebuddy-install pnpm tsx tests/codebuddy/install-smoke.ts
```

Artifacts are under `oar-trial-run/codebuddy-install/` unless
`OAR_TRIAL_RUN_DIR` or `OAR_CODEBUDDY_INSTALL_DIAGNOSTICS` selects another
artifact directory.
