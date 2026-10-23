# tsrs migration: 2026-10-20

OAR typechecking and library/CLI emission move from official TypeScript 6.0.3
to `tsrs@0.18.0-ts7.1.0-dev.20260929`, pinned exactly. The native executable
reports `7.1.0-dev.20260930.4`. This changes compiler semantics as well as
execution speed. The upstream [repository](https://github.com/oxc-project/tsrs)
and [compatibility notes](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md)
describe the TypeScript 7.1 target and supported options.

The official `typescript ~6.0.3` dependency remains for the clean-install
consumer check only. oxlint/oxlint-tsgolint, tsx, esbuild and vitest are unchanged.

## Timings

Measured sequentially on Linux x64, Node 24 and pnpm 11.22.0, starting from
`60ad09b` and the same sources with only the compiler/dependency switch.
One wall-clock sample per command, including pnpm startup. "Cold" means both
package `dist` directories and `.tsbuildinfo` files were removed; it does not
mean the operating system's filesystem cache was flushed. The typecheck
command also builds OAR before checking the CLI.

| Root command | Cache | TypeScript 6.0.3 | tsrs 0.18.0 |
|---|---|---:|---:|
| `pnpm run typecheck` | Cold | 42.30 s | 4.02 s |
| `pnpm run build` | Cold | 14.59 s | 2.47 s |
| `pnpm run build` | Warm | 7.18 s | 2.09 s |
| `pnpm run typecheck` | Warm | 34.39 s | 3.82 s |

These are observations on this machine, not a cross-platform performance
promise. Reproduce in clean worktrees with the corresponding lockfiles:
remove `packages/{oar,cli}/dist` and `packages/{oar,cli}/.tsbuildinfo`, time
`pnpm run typecheck`, remove the generated directories/caches again, then
time `pnpm run build` twice and `pnpm run typecheck` once. Save the output
before switching compilers.

## Three-way emitted-file comparison

An independent clean build with official `typescript@7.0.2` (the native
TypeScript compiler) uses the same configs and source directories. Against
that build, tsrs emits **all 1,100 library and all 60 CLI files byte-identically**,
including both kinds of maps. Build caches are excluded from the comparison.
Thus the differences below reproduce with official TS 7 as well; they are
changes from TS 6 to TS 7, not differences unique to tsrs.

### TypeScript 6.0.3 versus TypeScript 7 / tsrs

TS 6 and tsrs emit the same relative file lists: 1,100 library files and 60
CLI files. Every JavaScript file is byte-identical. No runtime source code or
typechecking options changed.

| Package | Changed declarations | Changed declaration maps | Changed JavaScript maps |
|---|---:|---:|---:|
| Library | 1 | 15 | 79 |
| CLI | 1 | 2 | 3 |

All map differences are in `mappings` only; filenames, source paths and other
metadata match. They were not claimed to be byte-identical or exhaustively
verified in a debugger.

- Library `brands.d.ts`: the `pi-durable` property and its nested properties
  move in the inferred object type. Property names and types are unchanged.
- CLI `mcp-output-schemas.d.ts`: object property order changes. In the
  inferred schema union, the aborted/failed alternatives' optional
  `structuredOutput` properties change from `never` to `{}`. This is a real
  inferred-type difference, not formatting. The file is an internal CLI
  module with no advertised TypeScript entry point. Its JavaScript and
  serialized MCP schemas are unchanged. No source annotation was added to
  conceal the compiler difference.

To repeat the comparison, save each build's `dist` trees and run:

```sh
pnpm tsx experiments/compare-compiler-output.ts /tmp/tsc-oar /tmp/tsrs-oar
pnpm tsx experiments/compare-compiler-output.ts /tmp/tsc-cli /tmp/tsrs-cli
diff -u /tmp/tsc-oar/brands.d.ts /tmp/tsrs-oar/brands.d.ts
diff -u /tmp/tsc-cli/mcp-output-schemas.d.ts /tmp/tsrs-cli/mcp-output-schemas.d.ts
```

For the third build, install `typescript@7.0.2` into a separate temporary
directory so it does not replace OAR's consumer-check dependency. Remove
both package `dist` directories, invoke that installation's `tsc -p
tsconfig.build.json` from `packages/oar` and then `packages/cli`, save both
trees, and run the same comparison script against a fresh tsrs build.

The comparison script fails for different file lists, changed executable
bytes or changed map metadata, and lists declaration/mapping differences
for manual review.

## Existing incremental caches

Starting with the TypeScript 6.0.3 output and `.tsbuildinfo`, `pnpm run build`
succeeds in 2.51 s and replaces both caches with version
`7.1.0-dev.20260930.4`. Those emitted files are byte-identical to a clean tsrs
build. Restoring the old library cache and adding
`export const migrationNegative: string = 123;` still produces TS2322 and
exit code 2. The negative fixture and generated output were removed afterward.
That confirms tsrs recognizes the old compiler's cache format and does not
silently trust it. The final configs also move `.tsbuildinfo` into `dist`,
so old root-level caches are unused and deleting `dist` invalidates the
current cache. Rebuilding after deleting only `dist` emits all 1,100/60
files, byte-identically to the previous full build. Both package manifests
exclude `dist/.tsbuildinfo` from the tarballs. The clean-install check deletes
`dist` before packing and rejects installed build caches. CI uses fresh
checkouts with no restored build outputs. This does not promise compatibility
with every historical or future cache format.

## Consumer check and CI boundary

The clean-install check packs the tsrs-built library and CLI, installs them
in an empty npm host, and invokes official TypeScript 6.0.3 on the host's
imports. Both the initial migration and the final clean-build/cache-exclusion
version passed. It retains the existing check for OAR/host errors separately
from known upstream SDK declaration errors. Final CI status is recorded in
the pull request.

At 2026-10-20 19:55 UTC, npm's latest tsrs is the pinned 0.18.0 version and
`npm view @tsrs/win32-x64 version` returns E404. Its optional packages cover
Linux x64/arm64 (GNU and musl) and macOS arm64. The upstream compatibility
notes place Windows support in the next release; Intel macOS also has no
published binary. The existing three-OS CI matrix is unchanged. This PR
must wait for a published Windows version, an updated exact pin and a green
Windows check before merging. There is no tsc fallback or skipped Windows
job. Recheck the registry and upstream notes before updating that conclusion.
