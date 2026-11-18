# Kimi read-only background refresh

November 17, 2026, Linux x64, Node 24.19.0, native Kimi 2.6.3. With a synthetic
OAuth server, a single short-lived skills query could leave an expired refresh token on disk after
the server had rotated it. A later usage query then sent the old token and
native Kimi cleared both access and refresh credentials. OAR now disables
background model-directory refresh in both read-only Web processes, leaving
explicit account-usage refresh enabled.
Tracked in [upstream #5034](https://github.com/MoonshotAI/kimi-code/issues/5034),
separate from the [first-Web-token race](../kimi-web-startup/README.md).

## Native lifecycle and scope

At native commit `b0de2fbd2de04d87689225aafd3912e5d193b62d`,
[`modelCatalogRefreshScheduler.ts`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/kap-server/src/services/modelCatalog/modelCatalogRefreshScheduler.ts)
starts an un-awaited provider-model refresh by default and schedules a
six-hour interval. `dispose()` clears the timer without joining an in-flight
refresh. Provider discovery can rotate expired OAuth credentials. The
[`OAuth manager`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/oauth/src/oauth-manager.ts)
saves the replacement only after the refresh request returns. On 401/403 it
waits 100 ms and checks for another process's replacement; otherwise it writes
a revoked tombstone with both credentials empty. Its comments explicitly
account for refresh-token rotation.

OAR's former skills cleanup immediately stopped the process tree after
reading and unregistering its workspace. That can interrupt this unrelated
background refresh between server acceptance and local persistence. The
same loss occurs without concurrent readers, so it does not prove that
Kimi's OAuth lock failed.

OAR supplies two native child-environment overrides:
`KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START=0` and
`KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS=0`. They take precedence over
caller values and native configuration in the source above. No caller
environment or user configuration is edited. Account usage still invokes
`/api/v1/oauth/usage`, whose needed refresh runs normally. Session processes
and unrelated native processes keep their existing settings.

## Controlled evidence

[`probe.ts`](probe.ts) uses isolated homes and a synthetic OAuth server that
accepts only its current refresh-token generation. Acceptance rotates the
server generation immediately; its reply is delayed 600 ms to expose the
shutdown interval. Native executable bytes and response handling are unchanged.
Every home has a preseeded local Web token, excluding first-token creation.
The unprotected path performs the former native skills query and immediate
cleanup; the protected path calls the actual OAR adapter. These controlled
rates are not estimates of production frequency or real-service grace periods.

All rows in [`selected.json`](selected.json) correspond to this matrix:

| Path, three rounds each | Refresh and disk result |
| --- | --- |
| Unprotected native skills, then normal usage | Skills rotate generation 0 to 1 but leave the old file; usage submits 0 when 1 is required, then both fields are cleared, 3/3 |
| Actual adapter skills, then normal usage | Skills make no provider requests and leave credentials unchanged; usage refreshes once and saves the current generation, 3/3 |
| Actual adapter concurrent skills and usage | Both succeed, one refresh and current credentials preserved, 3/3 |
| Unprotected skills, then usage with `KIMI_DISABLE_OAUTH_LOCK=1` | Skills already lost the replacement; usage adds no refresh, returns `access_token_expired`, leaves the stale file unchanged, 3/3 |
| Only lock-disabled usage | No refresh, no credential change, `access_token_expired`, 3/3 |
| Actual adapter skills, then lock-disabled usage | No refresh in either operation, original credentials remain current on the server, `access_token_expired`, 3/3 |

The lock-disabled controls match Raft's usage environment. That setting
prevents usage-side rotation; it cannot repair an earlier skill-query loss.
These synthetic controls used no real account, browser login, model prompt
or paid request. The separate [real-service observations](real-service-2026-11-18.md)
did not reproduce login loss in three old-path rounds. Both protected
controls preserved login with exactly one usage refresh. The service's
reuse/grace policy remains unknown, including whether interrupted skills
requests reached it.

## Reproduction and regression

```sh
pnpm tsx experiments/kimi-readonly-refresh/probe.ts /absolute/path/to/kimi /tmp/kimi-refresh.json
```

Only synthetic generation numbers, route/status observations and credential
state booleans are recorded, never credential contents or native banners.
The fixture snapshots its observations before later calls can mutate them.
The unit regression first fails on the unmodified startup helper and passes
with both child overrides while retaining the caller environment. The native
vendor regression explicitly enables both background paths in the input,
requires skill discovery to make no provider request or credential change,
then verifies normal usage refresh and unchanged user configuration.

This change prevents unrelated background rotation. Explicit refresh during
shutdown has the additional measurements below; neither change promises that
interrupted writes are safe.

Reconsider the background-refresh overrides only after a native release
addressing [#5034](https://github.com/MoonshotAI/kimi-code/issues/5034) passes
the same sequential, concurrent and interrupted-refresh controls with native
defaults. An issue closure is not persistence evidence. The native shutdown
path and bounded cleanup below remain necessary.

## Native shutdown and deadlines

For a ready Web process OAR captures descendant ownership, sends authenticated
`POST /api/v1/shutdown`, and awaits actual exit. Native
[`shutdown.ts`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/kap-server/src/routes/shutdown.ts)
schedules server shutdown after replying; its acknowledgement alone does not
establish exit or persistence. Cleanup uses its own signal after the query's
signal has been cancelled. Before readiness, startup failure retains the
existing process cleanup. Failed shutdown and grace expiry fall back to the
existing bounded process-tree termination.

The grace is two seconds for the shutdown request and exit together. The
initial 600 ms delayed-refresh controls exited naturally in 693 to 709 ms;
two seconds gives that observed interval headroom. This is a measured local
choice, not a limit on real OAuth response latency. The account-usage and
skills answer deadlines include startup, requests and awaited cleanup. At
expiry the caller receives its existing timeout outcome immediately, while
owned cleanup continues; it does not kill a ready process merely to answer.

[`shutdown.ts`](shutdown.ts) and [`shutdown-selected.json`](shutdown-selected.json)
retain all three rounds of each control on native 2.6.3:

| After a refresh is accepted | Observed outcome |
| --- | --- |
| Cancel then immediate termination | 3/3 leave the old credential generation on disk; exit code 0 does not mean persistence |
| Cancel then actual OAR native shutdown | 3/3 save the replacement, exit naturally; cleanup after the cancelled answer takes 707 to 741 ms |
| 50 ms query deadline then actual OAR native shutdown | Caller answers in 51 to 52 ms, without killing; 3/3 save the replacement and finish cleanup 674 to 743 ms later |
| 50 ms deadline with a four-second refresh reply | Caller answers in 51 to 52 ms; 3/3 hit the two-second grace and finish fallback cleanup in 2036 to 2041 ms, leaving the old generation |

These timings deliberately use a local delayed reply. The first three paths
use 600 ms; the last exceeds the grace. All processes exited, and there was
no retry. The deadline probe uses the same query-deadline owner and actual
startup/shutdown helpers; unit regressions separately pin both public reader
paths' exact deadlines, no early kill, and bounded cleanup. A native crash,
early native exit or failed shutdown may still lose a replacement even within
the grace. The server's real reuse/grace policy remains unmeasured.

```sh
pnpm tsx experiments/kimi-readonly-refresh/shutdown.ts /absolute/path/to/kimi /tmp/kimi-shutdown.json
```
