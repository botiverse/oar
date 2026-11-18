# Runtime installer package fixtures

`packages.json` stores two genuine `npm pack` archives as base64 with their
SHA-512 integrity and complete readable source files. Both packages identify
as `oar-ci-fixture@1.2.3`; their executable prints either `1.2.3` or `9.8.7`.
The latter tests refusal to publish an executable whose version differs from
the selected pin.

The four baseline/candidate and matching/mismatching controls reuse these
immutable bytes. Every control still downloads and verifies the archive,
performs a fresh real npm installation, runs the executable, and checks
publication or refusal and retained diagnostics. It also compares both
installed files byte for byte with the recorded sources. Installation results,
private directories and mutable state are never shared between cases.

This removes fixture packaging from the installer test's deadline. Windows
hit its former first `npm pack` 30-second bound twice in unrelated changes:
[PR 906 job](https://github.com/botiverse/oar/actions/runs/44180789641/job/134384241542)
and [PR 912 job](https://github.com/botiverse/oar/actions/runs/44201899849/job/134457853573).
The exact slow operation remains unknown; [issue 915](https://github.com/botiverse/oar/issues/915)
tracks the evidence. No installer assertion or timeout is relaxed, and npm
packaging speed is not part of the runtime installation contract.

Regenerate deliberately after changing the two source definitions in
`rebuild.mjs`:

```sh
node .github/fixtures/runtime-install/rebuild.mjs
node --test --test-name-pattern='real offline npm install' .github/scripts/runtime-ci.test.mjs
```

Preparation performs two offline, script-disabled npm packs in disposable
homes with the original 30-second bound, publishing the JSON only after both
succeed. `oar-trial-run/runtime-fixture-preparation.json` retains each attempt's
elapsed time, exit status, signal, spawn error and output, including on failure.
A failed preparation leaves the previously checked-in fixture intact. The
preparation command is not part of normal CI and adds no retry.
