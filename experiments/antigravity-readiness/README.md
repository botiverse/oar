# Antigravity readiness evidence

This experiment runs the full OAR behavior and vendor suites with exact native
Antigravity 1.5.10 and 1.5.11 on Linux, macOS and Windows. It uses isolated
settings and a local scripted Gemini provider. It does not sign into an account
or make paid model calls. Accepted runtime pins remain unchanged.

The workflow runs on pull requests changing this experiment, and by manual
dispatch. Every stage after installation runs even if an earlier stage fails.
Original failures and provider traces remain in the per-version/platform
artifact; repeats are separate observations, never replacements for failures.

- Full behavior: prompt, steer, queue, abort, disposal and the common contracts.
- Full vendor suite: MCP, native skills and runtime-specific behavior. Windows
  stays on the native skill query. The 1.5.11 Windows fallback has an additional
  explicit control.
- `probe.ts`: configured-provider and signed-out auth/usage queries; prompt and
  two disposals with process PID/start identities recorded before and after;
  spaces and Unicode in cwd; a directory junction on Windows (symlink on POSIX);
  and an uppercase `.CMD` launcher plus a native executable under a spaced
  Unicode path on Windows. Session records and MCP process metadata are retained.
- `repeat-mcp.ts`: three fresh repetitions of the existing MCP name-clash test,
  relevant to [#871](https://github.com/botiverse/oar/issues/871). The full vendor
  suite also runs this test. Passing samples cannot prove an intermittent
  startup defect is absent. Keep the control unless independent evidence
  establishes its removal condition.

The probe records survivors immediately when disposal returns and again after
five seconds if any remain. Any survivor after that observation fails the
probe; fixture cleanup targets only retained PID/start identities. This does
not change OAR's product timeouts or the existing suite's cleanup assertions.

`versions.json` preserves official archive URLs and SHA-512 digests. The 1.5.10
entries come from the frozen Nov17 candidate discovery (run 44126892829); 1.5.11
matches `.github/antigravity-file-skills.json` and the Nov18 official Windows
manifest. The shared installer verifies the digest and exact native version
before publishing an executable path. Installation evidence retains the
manifest hash and artifact identity.

## Initial Linux control, November 18

[Selected observations](local-control.json) record both exact versions passing
prompt/dispose, spaced Unicode cwd and directory symlink probes, with no
observed process survivors. Three fresh MCP collision controls pass on 1.5.11.
These are local smoke checks; the six CI lanes supply the cross-platform suites.

Both versions recognize the synthetic provider and refuse signed-out usage.
Under that provider, 1.5.10 native `/usage` answers SUCCESS with empty groups;
1.5.11 exits 2 and explicitly says usage is unavailable with a Gemini API key.
OAR rejects both unusable quota answers. Neither result establishes real
Google account usage, and neither is counted as a quota pass.

## Limits

A synthetic Gemini provider does not establish Google OAuth login, real account
quota/credits, OAuth refresh or production model reliability. The query probe
records what native auth/usage reports for that configuration and for an empty
home. Configured-provider quota is an observation, not a pass assertion: the
synthetic API-key fixture has no Google quota, and its adapter error and native
reply are retained. Signed-out auth/usage and configured-provider auth are
asserted. A signed-in Windows smoke test would add those account-specific facts and
real model/tool completion, but needs a separately arranged Windows machine and
account. These CI samples do not estimate a production failure rate or cover
every Windows antivirus, corporate policy, terminal, shell or filesystem.

## Local control

Use a frozen entry supported by the current platform, then run with the selected
executable path exported as `OAR_ANTIGRAVITY_BIN` and the expected version as
`OAR_READINESS_VERSION`:

```sh
node .github/scripts/runtime-install.mjs antigravity-1-5-11 experiments/antigravity-readiness/versions.json
OAR_TEST=antigravity-aimock pnpm tsx experiments/antigravity-readiness/probe.ts
```

Outside Actions, the installer report supplies the executable path; it does not
mutate the parent shell. Set `OAR_TRIAL_RUN_DIR` to retain each run separately.
