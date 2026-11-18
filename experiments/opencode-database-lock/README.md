# OpenCode warm database lock

Measured on Linux x64, 2026-11-17, unmodified OpenCode 1.19.5 and Node
24.19.0. No login, model prompt or provider request. This investigates
[OAR issue 876](https://github.com/botiverse/oar/issues/876).

## Native cause and scope

Two native ACP processes can collide while recovering a committed WAL over
an already initialized schema. The SQLite native layer requests WAL mode
before the database layer installs its 5000 ms busy timeout:
[sqlite.bun.ts](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/database/sqlite.bun.ts),
[database.ts](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/database/database.ts).
The compiled executable contains that same early pragma. A later opener
fails immediately on recovery locks, before answering ACP initialize.

Selected strace from the first traced pair, relative to A's first lock.
Both use the same database SHM file; local paths and PIDs are omitted.

```text
A +0.000000s F_WRLCK offset=120 len=1 -> 0
A +0.000267s F_WRLCK offset=121 len=2 -> 0
B +0.017573s F_WRLCK offset=120 len=1 -> EAGAIN
B +0.017608s F_RDLCK offset=122 len=1 -> EAGAIN
B +0.0188s   closes database, then exits 1 with "database is locked"
A +0.386s    releases recovery lock
```

The controlled trigger adds a separate test table and leaves 64 MiB of
committed WAL pages by ending a Python SQLite writer without closing its
connection. This establishes a native warm-database recovery failure. It
does not claim that production writes this table, or prove that the earlier
CI failures hit this precise pragma.

The Linux release failure was
[run 44143001746, job 134250660948](https://github.com/botiverse/oar/actions/runs/44143001746/job/134250660948).
Its serial preparation reported ready after 1985 ms. A later image-case
open failed after 975 ms, overlapping another open, with `database is locked`.
The original attempt artifact is ID 14356070361, created at 18:01 UTC;
ID 14355739943 belongs to the passing rerun at 18:23 UTC. The macOS sample
in issue 876 has the same native message. The separate Windows disk-I/O
signature is not attributed to this cause.

## Controls and result

[Selected results and raw-report fingerprints](results.json) retain every
paired timing used below. Raw protocol logs, lock traces and disposable
database files remain local. The interrupted duplicate termination-control
run is excluded.

| Control | Opens excluding serial preparation | Failed |
| --- | ---: | ---: |
| Warm shared directory, ten concurrent pairs | 20 | 0 |
| Warm separate directories, ten pairs | 20 | 0 |
| Warm shared directory, sequential | 20 | 0 |
| Shared directory with SIGTERM shutdown between pairs | 60 | 0 |
| WAL recovery, first reproduction | 12 | 3 |
| WAL recovery under strace | 12 | 6 |
| WAL recovery, experimental timeout-first binary copy | 12 | 0 |
| WAL recovery, unchanged executable, unguarded comparison | 12 | 5 |
| Same comparison, gate released at initialize | 12 | 0 |
| Actual OAR adapter with the gate | 12 | 0 |

The comparison's second process waited a median **1659 ms**, range
1562 to 2143 ms. Complete open took a median 2946 ms for the first gated
process and 4379 ms for the second; successful unguarded opens took a
median 2725 ms. Failed opens are excluded from that successful-open median.
After the first initialize response, both processes remained alive
concurrently for 1237 to 1444 ms in every gated pair. Preparation times
are excluded, including one 14-second preparation outlier. The actual
adapter's twelve opens all completed and disposed; its own timing rows
include a slower fourth pair rather than discarding it.

The binary-copy counterfactual replaces the redundant early WAL pragma
with a busy-timeout pragma of exactly the same byte length; the database
layer's later WAL pragma remains. It is a diagnostic modification, not a
source-built or released fix. The candidate upstream source correction is
to install the busy timeout before the native layer's first WAL pragma.

## Reproduce

Use a disposable, **new** output directory. The probe refuses an existing
one. It changes only its fixture database. Node 24+, Python 3 with sqlite3,
and the pinned OpenCode executable are required.

```sh
pnpm tsx experiments/opencode-database-lock/probe.ts /absolute/opencode /tmp/oar-wal-comparison 6 eof recovery,guarded
pnpm tsx experiments/opencode-database-lock/probe.ts /absolute/opencode /tmp/oar-wal-adapter 6 eof adapter
OAR_LOCK_STRACE=1 pnpm tsx experiments/opencode-database-lock/probe.ts /absolute/opencode /tmp/oar-wal-traced 6 eof recovery
python3 experiments/opencode-database-lock/patch-timeout.py /absolute/opencode /tmp/opencode-timeout-copy
pnpm tsx experiments/opencode-database-lock/probe.ts /tmp/opencode-timeout-copy /tmp/oar-wal-timeout 6 eof recovery
```

The first and third commands can exit 1 as the measured failure. Failures
stay in report.json and per-process stderr/stdout; the probe never retries.
Other modes are `shared,separate,serial`; `term` instead of `eof` selects
the termination control. Raw modes use Node child-process pipes and ACP
JSON directly; `adapter` imports the actual OAR session adapter. `guarded`
uses a small probe-only gate, retained so the original measurement can be
repeated independently of adapter changes.

Environment and configuration live under the fixture, with default
plugins, model fetching and updates disabled, and a loopback provider that
records and rejects any unexpected request. The native ancestor config
walk still applies; use a location without ancestor OpenCode configuration.
All measured provider request counts were zero. Nothing writes real
credentials.

## Adapter boundary and removal

The in-process gate uses the resolved XDG data directory, including the
native HOME fallback and symlink aliases. It owns startup from before
spawn through initialize, process exit or failed open. It never holds a
running session or retries a failed start. External hosts, non-ACP
processes, and OPENCODE_DB overrides shared across different data roots
are outside this coordination.

Queue wait and native spawn count against the existing 60-second
initialize deadline. There is no new public option: SessionOptions has no
opening AbortSignal or caller timeout today. The internal waiter accepts
cancellation, removes only itself and cannot release another owner's lock.
Unit regressions cover those boundaries, independent directories,
idempotent release, native failure, and 20 seconds queued leaving only
40 seconds for initialize.

The report is filed as
[upstream #64590](https://github.com/anomalyco/opencode/issues/64590). Upstream
closed it as not planned for v1 and requested the same reproduction on v2
([reply](https://github.com/anomalyco/opencode/issues/64590#issuecomment-6969503802));
that closure supplies no verified fix. Once a release addresses the early
busy-timeout ordering and passes the same recovery controls, limit the gate to
versions below that fixed release. The separate fresh-database bootstrap failure
is tracked in [#53879](https://github.com/anomalyco/opencode/issues/53879).
