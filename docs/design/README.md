# Design

Why oar exists and what it refuses to get wrong. Start here; each page is
small and links deeper instead of inlining.

| Read | To answer |
|---|---|
| [motivation.md](motivation.md) | Why does oar exist? Who is it for? Why not use each harness directly? |
| [hard-problems.md](hard-problems.md) | What exactly is hard about integrating an agent runtime? (15 problems, each with a real-runtime counterexample) |
| [foundations.md](foundations.md) | Which of those problems are merely work, and which are foundations where an early mistake breaks consumers forever? |
| [liveness.md](liveness.md) | "Is this agent alive or dead, and why?" — the stability question every multi-agent application hits |

Suggested order: motivation → hard-problems → foundations → liveness. Each
stands alone if you only need one answer.

Related material elsewhere in the repo:

- [`../../packages/oar/src/AGENTS.md`](../../packages/oar/src/AGENTS.md) — source ownership model (contracts / runtimes / shared / observe).
- [`../../AGENTS.md`](../../AGENTS.md) — the test estate and verification discipline that back the claims here.
- [`../../experiments/README.md`](../../experiments/README.md) — live probes with conclusions; the empirical evidence base.

Maintenance rule: these pages record settled design positions, not status.
When a position changes, change the page in the same commit as the code that
changes it — a stale design doc is worse than none.
