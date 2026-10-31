# OpenCode cold-start controls

Runtime version check: 2026-10-31.

The ordinary OpenCode behavior backend now initializes each temporary data
directory once, awaiting an independent native session open and disposal before
concurrent cases start. This prepares database initialization only. The shared
behavior cases, their concurrency, assertions and deadlines are unchanged;
product startup and vendor/sharing fixtures are unchanged.

The separate [observation command](../opencode-cold-start.ts) preserves the cold
case. Set `OAR_OPENCODE_BIN` to the desired executable and run:

```sh
pnpm tsx experiments/opencode-cold-start.ts oar-trial-run/opencode-cold-start
```

It opens two independent sessions concurrently in one fresh fixture HOME, then
two in another HOME after one serial open and disposal. It uses the OAR isolated
session entry, the native ACP program and a local provider, but sends no prompts.
Every open and disposal outcome is retained in `report.json`. A native or fixture
failure returns exit code 1 without retries. No observed cold failure means only
`not_reproduced`; a missing cold pair is `observation_incomplete`.

On a local Linux x64 host, with the product tree from main `75c4f52` and Node
24.19.0, the first observations were:

| Version | Concurrent cold opens | Concurrent prepared opens | Source |
| --- | --- | --- | --- |
| 1.19.5 | 1 of 2 opened; the other exited 1 with `CREATE TABLE workspace` in stderr | 2 of 2 opened | [full selected report](2026-10-31-v1.json) |
| 2.2.3 | 1 of 2 opened; the other exited 1 before its standalone server reported readiness | 2 of 2 opened | [full selected report](2026-10-31-v2.json) |

Both commands exited 1, preserving the cold failures. These small samples do not
measure failure frequency or prove the exact SQLite error behind the v2 startup
failure. The earlier [native server probe](../opencode-startup-report.md) retains
the more specific database-contention evidence without the OAR adapter.

With preparation, the unchanged behavior suite passed 17 cases with 2 capability
skips on 1.19.5, and 15 with 4 skips on 2.2.3, using two concurrent cases. This is
local Linux evidence; the new revision's CI supplies macOS validation, while
Windows ACP behavior remains in the separate main-push observation workflow.
