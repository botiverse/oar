# Kimi first Web startup

November 17, 2026, Linux x64, Node 24.19.0. Kimi 2.4.1 and 2.6.3 can
create different persistent Web bearer tokens when two processes first open
the same Kimi home. The later atomic rename replaces the first token; the
first process then rejects its own printed startup bearer with HTTP 401.
This is independent of the OAuth refresh-token lock.

## Native cause and controlled reproduction

The 2.6.3 source at
[`persistentToken.ts`](https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/kap-server/src/services/auth/persistentToken.ts)
reads and trims `server.token`, generates a token when missing or empty,
then atomically renames a temporary file. Creation has no cross-process lock.
The native token store follows file changes, so an earlier bearer stops
working when a later writer replaces it. The inspected 2.4.1 and 2.6.3 bundled
`loadOrCreateServerToken` and `createTokenStore` functions were identical.

[`schedule.ts`](schedule.ts) supplies a local Node preload that holds two
missing-file observations until both processes have observed them, delays
the second rename until the first banner, and delivers the first usage
request after replacement. It changes filesystem/request timing only; it
neither changes native source nor substitutes tokens or response payloads.
Its 1.5-second waits are bounded. This deliberately forces the interleaving,
so its failure frequency and elapsed time are not production estimates.

The selected `baseline241Scheduled` rows show three failing requests in
six unguarded starts, all HTTP 401, versus six successful starts when a
manual readiness gate serializes only startup. The current 2.6.3 `rows`
repeat the same **3/6 failures unguarded and 0/6 with OAR's actual startup
helper**. Both native processes remain alive until both requests settle.
The earlier macOS CI sample lacks its HTTP status and native token history;
this experiment does not establish its exact cause.

## OAR boundary

Account usage and skill discovery share one in-process gate per resolved
Kimi home. It follows raw nonempty `KIMI_CODE_HOME`, otherwise the native home
fallback, and resolves symlink aliases even before the final directory exists.
Only missing or whitespace-only `server.token` content enters the gate.
The check computes native trim/nonempty acceptance and discards the contents;
it does not validate a token format, retain it, log it or write the file.
A queued caller rechecks after acquiring ownership. Existing tokens bypass
startup serialization, and a ready process continues querying while the next
starts. Readiness, exit and failed startup release ownership. The original
reader deadline covers queueing and startup; cancellation removes only the
cancelled waiter. Failed starts are never retried.

The `nativeTokenStates` samples verify missing, zero-length, whitespace and
an orphan temporary file cause native creation. A nonempty partial string is
accepted unchanged by native Kimi, so OAR treats it as existing too.

In six ordinary current-version cold pairs, all 12 requests succeeded and
the median process-start separation was **1.877 s** (1.829 to 2.036 s).
In six preseeded pairs, all 12 succeeded and the median separation was
**4.5 ms** (0 to 9 ms). These `starts` are timestamps from a process preload,
not a measurement of lock acquisition alone. All paired direct queries can
overlap after startup.

Three additional pairs through `accountUsage()` with expired synthetic OAuth
credentials all returned available. Three mixed `accountUsage()`/`skills()`
pairs with fresh synthetic OAuth credentials also succeeded. The mixed
control intentionally excludes background refresh and its shutdown lifecycle;
this gate does not extend process lifetime or serialize entire queries.

The gate does not coordinate separate OAR host processes or a native process
started elsewhere. No paid provider, real account, model prompt or login was
used. These are Linux observations, not Windows/macOS race measurements.
Remove or restrict the gate once an upstream release fixes first-token
creation and passes the same before/after controls.

## Reproduction and validation

```sh
node --import tsx experiments/kimi-web-startup/probe.ts /absolute/path/to/kimi /tmp/kimi-startup.json
```

[`selected.json`](selected.json) contains only cited outcomes, process timing,
allowlisted HTTP route/status observations and synthetic credential-state
booleans. Private banners, bearer values and account identifiers are omitted.
The script creates isolated homes and removes them after retaining its results.

Unit regressions cover shared ownership, queued cancellation, stale releases,
pre-abort, symlink/fallback resolution, token states, warm bypass, readiness
release, failed spawn/exit, and one deadline across queue and startup for both
reader paths. Startup-timeout cleanup remains owned; the later
[shutdown change](../kimi-readonly-refresh/README.md#native-shutdown-and-deadlines)
separates the caller deadline from background cleanup. Native 2.4.1 login, account environment, expired usage and skill
inventory checks passed (15 cases).
