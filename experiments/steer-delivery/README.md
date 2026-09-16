# Steer delivery and identity

Local probe, 2026-09-16: Codex CLI 0.154.0, Claude Code 2.1.273,
Pi SDK 0.84.2, OAR baseline aacbfd6.

```sh
pnpm exec tsx experiments/steer-delivery/probe.ts codex
pnpm exec tsx experiments/steer-delivery/probe.ts claude
pnpm exec tsx experiments/steer-delivery/probe.ts pi
pnpm exec tsx experiments/steer-delivery/native-identity.ts codex
pnpm exec tsx experiments/steer-delivery/native-identity.ts claude
```

Real installed harnesses run against a local scripted provider in a temporary
workspace. The script requests only `sleep 2; echo boundary` (or the equivalent
probe marker). Provider credentials are mock values; Codex and Claude use
fresh config directories, Pi uses the existing aimock agent directory helper.
No login or paid model request is needed. Pi may discover globally installed
skills through its SDK; this probe does not claim a filesystem sandbox.

The provider first requests the harmless tool, then completes. We send steer
when the runtime reports the tool call. A function fixture examines each
normalized provider request **before journal truncation** and records only
whether its messages contain the unique probe marker. The fixed model reply
is not evidence of obeying the steer; the actual provider request is the
inclusion evidence.

`observed-*.json` captures current OAR request/response/frame ordering;
`identity-*.json` tests additional native client identity knobs directly.
Native user frames are retained; full agent-end conversation snapshots are
omitted. Random native IDs and timestamps are observation data.

An initial Claude trial read aimock's capped journal and missed the marker.
The function fixture avoids that false negative: do not use capped journal
absence to conclude a runtime dropped input. Latest artifacts all capture
provider inclusion. The scripts test one unique steer at a tool boundary;
not repeated-text ambiguity, abort races, post-turn delivery, or replay after
resume. Grok and Kimi were inspected locally, not run against a mock provider.

Findings and proposed consumer contract: [steer delivery](../../docs/runtimes/steer-delivery.md).
