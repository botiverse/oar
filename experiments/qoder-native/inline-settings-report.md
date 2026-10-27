# Draft: Qoder inline settings share a temporary file across processes

Prepared on October 27, 2026 for a human to submit. Not posted upstream.
The [official troubleshooting guide](https://docs.qoder.com/cli/troubleshoot-faq)
links the [Bug Reports forum](https://forum.qoder.com/c/bug-reports/6).

## Summary

Qoder CLI 1.1.79 on Linux x64 once exited during startup with
`Unexpected end of JSON input` while reading its shared inline-settings
file. The installed bundle derives that file's name only from the settings
contents and overwrites it. Processes using the same inline JSON therefore
share the same path even with separate HOMEs.

An unchanged rerun passed. The focused 12-serial / 12-concurrent comparison
also passed without reproducing the parse failure. This is an intermittent
observation plus a shared-path design concern, not a deterministic reproducer
or proof of the exact failing interleaving.

## Environment and observed failure

- Qoder CLI 1.1.79 from `@qoder-ai/qodercli`, Linux x64, Node 24.19.0.
- Native bidirectional stream-JSON mode with local fake responses, isolated
  HOMEs, and no real account or paid model call.
- Inline argument: `--settings '{"security":{"auth":{"useExternal":true}}}'`.
- One concurrent session failed before its initialize/control response:

```text
/tmp/qoder-settings-1cc73090ab49cfc6.json: Unexpected end of JSON input
```

Other cases completed, and rerunning the suite without changes passed all
17 applicable cases. No retry, timeout increase or assertion removal was
used to turn the original attempt into a pass.

## Installed-bundle observation

The settings argument handling in `bundle/qodercli.js` recognizes inline
JSON, takes the first 16 hexadecimal characters of its SHA-256, joins
`qoder-settings-${hash}.json` under the system temporary directory, then
writes it using `writeFileSync`. The JSON above hashes to
`1cc73090ab49cfc6`, matching the failure path. There is no per-process
component in that filename or atomic temporary-file replacement in that
write path.

A file being truncated and rewritten while another process reads it could
explain the partial JSON. We did not capture the write/read interleaving;
the matching path and hash alone do not establish that it caused this
particular failure.

## Comparison and workaround

From the OAR checkout, run:

```sh
OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-native/inline-settings.ts
```

The [probe](inline-settings.ts) opens native processes through initialize,
without a model prompt. All processes use separate HOMEs and a disposable
shared temporary directory. It retains each result and cleans up processes
and fixture files after use.

| Control | Passed | Failed |
| --- | ---: | ---: |
| Serial opens, identical inline settings | 12 | 0 |
| Concurrent opens, identical inline settings | 12 | 0 |
| Concurrent opens, one settings file per fixture | 12 | 0 |

The intermittent failure did not reproduce. Changing OAR's test fixtures to
pass their own immutable settings files also passed eight native cases,
17 shared cases (two skipped), and eight priority controls. Product callers
can likewise supply a file path through `--settings` to avoid the shared
inline-settings file. OAR forwards the native argument unchanged.

## Suggested improvement

Use a unique temporary filename for each process, or write the complete
contents to a unique temporary file and atomically replace the shared target.
This would avoid exposing a truncated shared file to readers. A native test
that deliberately interleaves the write and read would establish the race
more reliably than startup stress alone.
