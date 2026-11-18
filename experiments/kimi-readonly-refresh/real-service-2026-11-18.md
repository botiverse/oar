# Kimi real-service refresh observations

November 18, 2026, Linux x64, native Kimi 2.6.3.
Three consecutive old-path expiry controls **did not reproduce login loss**
on the real service. Both protected controls, sequential and concurrent,
kept login with exactly one refresh from usage and none from skills.
The service's policy for reusing a recently rotated refresh token remains
unknown. These results qualify the synthetic reproduction in
[the original report](README.md) and upstream
[#5034](https://github.com/MoonshotAI/kimi-code/issues/5034).

## Method and scope

A dedicated test account used an isolated native home. Native browser login
created credentials locally. Each control waited for the recorded access
expiry; no clocks, timestamps or credential expiry fields were edited.
No model prompt was submitted. The protected sequential and concurrent
controls followed a fresh native login. The three old-path controls then
ran after successive natural expiries.

The old adapter was commit `f0fdbd74153f6274719117ff3bb5173014144fcd`, before
background refresh was disabled. It read skills and then immediately read
usage with native catalog defaults. The protected adapter was released
OAR 0.116.0, commit `867269c684553b586817c127bb65cd52fdb6df18`, which disables
catalog refresh in these readers. This release does **not** include the
later graceful-shutdown change in #914, so these observations do not validate
that separate change against the real service.

A local observer wrapped the native process's existing `fetch` call and
response `json` method. It passed results through unchanged and recorded
only event timing and allowlisted booleans. It made no additional requests.
The parent compared credential presence and change without recording values
or fingerprints. Observation adds timing overhead; a recorded request start
proves invocation, not server receipt. A missing response observation cannot
establish whether the server accepted or rotated anything.

## Results

All five controls began with expired access credentials, ended with access
and refresh credentials present, and left no observed native process alive.
The event times and gaps below include local observation overhead.

| Control | Start UTC | Skills refresh | Usage refresh | Disk and observation |
| --- | --- | --- | --- | --- |
| OAR 0.116.0 sequential | 06:48:59 | None | One successful rotated response | Skills left disk unchanged; usage saved the replacement |
| OAR 0.116.0 concurrent | 07:04:56 | None | One successful rotated response | Replacement saved; login retained |
| Old path, round 1 | 07:20:42 | Successful rotated response before skills returned | None | Skills saved the replacement; usage started about 8 ms after return |
| Old path, round 2 | 07:36:27 | Started, no response observed | Successful rotated response | Skills left expired disk credentials unchanged; usage began about 2 ms after return and saved a replacement |
| Old path, round 3 | 07:52:15 | Started, no response observed | Successful rotated response | Skills left expired disk credentials unchanged; usage began about 3 ms after return and saved a replacement |

Round 1 never exercised reuse of the previous refresh token. In rounds 2
and 3, usage successfully refreshed with the unchanged disk token. Either
the earlier skills request did not reach the service, or the service still
accepted that token. These observations cannot distinguish those cases and
do not measure a grace period. Three non-reproductions do not establish a
production failure rate or invalidate the synthetic persistence race.

Usage projection threw in every control because the successful response
exposed no usable quota data. This was separate from authentication:
refreshes succeeded, replacements persisted and login remained present.
A separate native `/usage` comparison displayed "No usage data available."
without an error; quota projection is tracked separately in
[PR #923](https://github.com/botiverse/oar/pull/923).

An earlier old-path sample is excluded from the three clean rounds. Its
usage call was refused locally by the probe's HTTP-environment setup before
native launch. Correcting that setup added about 72 seconds between skills
and usage. The later usage refresh succeeded, but that gap makes the sample
unsuitable for the immediate-read comparison above.

## Selected observations

The following rows are selected from the local observations. They contain
only timing, phase, counts and booleans supporting the results above, not
request bodies, credential material, account identifiers or fingerprints.
`refresh_started` means the observer entered the native fetch call;
`refresh_finished` means native parsed a response. Credential persistence
is checked separately in the per-control summary.

```json
[
  {
    "mode": "current-sequential",
    "startedAt": "2026-11-18T06:48:59.358Z",
    "finishedAt": "2026-11-18T06:49:05.728Z",
    "refreshRequests": 1,
    "refreshResponses": 1,
    "successfulRefreshes": 1,
    "observedRefreshRotation": true,
    "requestObservationComplete": true,
    "startedExpired": true,
    "accessPresentAfter": true,
    "refreshPresentAfter": true,
    "refreshChangedOnDisk": true,
    "events": [
      {
        "at": "2026-11-18T06:49:04.469Z",
        "phase": "current-sequential-usage",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T06:49:04.827Z",
        "phase": "current-sequential-usage",
        "event": "refresh_finished",
        "succeeded": true,
        "returnedRefreshChanged": true,
        "rejected": false
      }
    ],
    "allObservedNativeProcessesGone": true,
    "skillsDiskRefreshChanged": false,
    "skillsDiskAccessExpired": true
  },
  {
    "mode": "current-concurrent",
    "startedAt": "2026-11-18T07:04:56.021Z",
    "finishedAt": "2026-11-18T07:05:00.464Z",
    "refreshRequests": 1,
    "refreshResponses": 1,
    "successfulRefreshes": 1,
    "observedRefreshRotation": true,
    "requestObservationComplete": true,
    "startedExpired": true,
    "accessPresentAfter": true,
    "refreshPresentAfter": true,
    "refreshChangedOnDisk": true,
    "events": [
      {
        "at": "2026-11-18T07:04:59.059Z",
        "phase": "current-concurrent-usage",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T07:04:59.465Z",
        "phase": "current-concurrent-usage",
        "event": "refresh_finished",
        "succeeded": true,
        "returnedRefreshChanged": true,
        "rejected": false
      }
    ],
    "allObservedNativeProcessesGone": true
  },
  {
    "mode": "old-clean-1",
    "startedAt": "2026-11-18T07:20:42.548Z",
    "finishedAt": "2026-11-18T07:20:50.950Z",
    "refreshRequests": 1,
    "refreshResponses": 1,
    "successfulRefreshes": 1,
    "observedRefreshRotation": true,
    "requestObservationComplete": true,
    "startedExpired": true,
    "accessPresentAfter": true,
    "refreshPresentAfter": true,
    "refreshChangedOnDisk": true,
    "events": [
      {
        "at": "2026-11-18T07:20:44.900Z",
        "phase": "old-clean-1-skills",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T07:20:45.267Z",
        "phase": "old-clean-1-skills",
        "event": "refresh_finished",
        "succeeded": true,
        "returnedRefreshChanged": true,
        "rejected": false
      }
    ],
    "allObservedNativeProcessesGone": true,
    "skillsToUsageGapMsApprox": 7.885,
    "skillsDiskRefreshChanged": true,
    "skillsDiskAccessExpired": false
  },
  {
    "mode": "old-clean-2",
    "startedAt": "2026-11-18T07:36:27.093Z",
    "finishedAt": "2026-11-18T07:36:33.404Z",
    "refreshRequests": 2,
    "refreshResponses": 1,
    "successfulRefreshes": 1,
    "observedRefreshRotation": true,
    "requestObservationComplete": false,
    "startedExpired": true,
    "accessPresentAfter": true,
    "refreshPresentAfter": true,
    "refreshChangedOnDisk": true,
    "events": [
      {
        "at": "2026-11-18T07:36:28.858Z",
        "phase": "old-clean-2-skills",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T07:36:32.117Z",
        "phase": "old-clean-2-usage",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T07:36:32.518Z",
        "phase": "old-clean-2-usage",
        "event": "refresh_finished",
        "succeeded": true,
        "returnedRefreshChanged": true,
        "rejected": false
      }
    ],
    "allObservedNativeProcessesGone": true,
    "skillsToUsageGapMsApprox": 2.43,
    "skillsDiskRefreshChanged": false,
    "skillsDiskAccessExpired": true
  },
  {
    "mode": "old-clean-3",
    "startedAt": "2026-11-18T07:52:15.104Z",
    "finishedAt": "2026-11-18T07:52:21.339Z",
    "refreshRequests": 2,
    "refreshResponses": 1,
    "successfulRefreshes": 1,
    "observedRefreshRotation": true,
    "requestObservationComplete": false,
    "startedExpired": true,
    "accessPresentAfter": true,
    "refreshPresentAfter": true,
    "refreshChangedOnDisk": true,
    "events": [
      {
        "at": "2026-11-18T07:52:16.878Z",
        "phase": "old-clean-3-skills",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T07:52:20.138Z",
        "phase": "old-clean-3-usage",
        "event": "refresh_started"
      },
      {
        "at": "2026-11-18T07:52:20.447Z",
        "phase": "old-clean-3-usage",
        "event": "refresh_finished",
        "succeeded": true,
        "returnedRefreshChanged": true,
        "rejected": false
      }
    ],
    "allObservedNativeProcessesGone": true,
    "skillsToUsageGapMsApprox": 2.553,
    "skillsDiskRefreshChanged": false,
    "skillsDiskAccessExpired": true
  }
]
```
