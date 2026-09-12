# Design

Why oar exists and what it refuses to get wrong. Start here; each page is
small and links deeper instead of inlining.

| Read | To answer |
|---|---|
| [motivation.md](motivation.md) | Why does oar exist? What is the bet behind it? Who is it for? Why not use each harness directly? |
| [hard-problems.md](hard-problems.md) | What exactly is hard about integrating an agent runtime? (15 protocol problems, each with a real-runtime counterexample) |
| [foundations.md](foundations.md) | Which of those problems are merely work, and which are foundations where an early mistake breaks consumers forever? |
| [liveness.md](liveness.md) | "Is this agent alive or dead, and why?": the stability question every multi-agent application hits |
| [patterns.md](patterns.md) | Where can each piece run? Two scenarios (one host; application on a server with the agent elsewhere), one diagram per pattern, who owns which layer, and what is shipped versus designed |
| [system.md](system.md) | How discovery, control, evidence, projection, and continuation form one agent-facing system? |
| [roadmap.md](roadmap.md) | Which system improvements are next, and what evidence gates them? |

Suggested order: motivation → hard-problems → foundations → liveness →
patterns → system → roadmap. Each stands alone if you only need one answer.

Related material elsewhere in the repo:

- [`../runtimes/`](../runtimes/README.md): native programming interfaces, concepts, and current OAR mappings; the evidence used to design the abstraction.
- [`../spec/`](../spec/README.md): the concrete record-stream contract (record shapes, attribution, session graph, cursor), deliberately separate, since design records *why* and spec records *what*.
- [`../../packages/oar/src/README.md`](../../packages/oar/src/README.md): source ownership model (contracts / runtimes / shared / observe).
- [`../development.md`](../development.md): the test estate and verification discipline that back the claims here.
- [`../../experiments/README.md`](../../experiments/README.md): live probes with conclusions; the empirical evidence base.

## How to maintain these docs

- These pages record settled design positions, not status. When a
  position changes, change the page in the same commit as the code that
  changes it; a stale design doc is worse than none.
- Routing: *why* a position holds (principles, evidence, what must not go
  wrong) belongs here; *what* the contract is (record shapes, envelope,
  semantics) belongs in [`../spec/`](../spec/README.md). Don't restate
  contract shapes here; link to the spec page instead.
- Native API behavior and its current OAR mapping belong in
  [`../runtimes/`](../runtimes/README.md). Link those facts when explaining
  a design choice; keep runtime internals only where they explain an
  observable API guarantee or limit.
- Adding or removing a page means updating the table above and the
  pointer in the root `README.md` in the same commit.
