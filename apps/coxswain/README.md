# coxswain

An intentionally small Electron cockpit for dogfooding `@botiverse/oar`.
Each window owns an `AgentHost` that can run one or more independent session
lanes. Humans inject through `prompt` or `steerOrQueue`, while agent replies
enter the conversation only through the temporary `say` CLI. Every lane has a
stable id, its own turn/observer state, lane-tagged host events, and an
append-only `oar-voyage/1` JSONL capture. The current renderer keeps the
single-lane launch flow for compatibility; fleet callers can use the explicit
IPC/API operations described below.

The complete OAR event stream remains visible in the Activity panel: Friendly
is the default semantic timeline and folds each tool call into one running/done
row; Raw keeps every OAR event one-for-one with its complete JSON available on
expansion.

Where the cockpit is headed — the ambitious dogfooding-and-verification
feature set and its build order — lives in [`ROADMAP.md`](ROADMAP.md).

## Run

```sh
pnpm --filter @botiverse/coxswain dev
```

Choose an available runtime, optionally provide its native model identifier,
and choose an existing working directory. Closing the window disposes the
all lanes and removes their temporary `say` bridges. Voyage files default to
`.coxswain/voyages` in the working directory; set `COXSWAIN_VOYAGE_DIR` to
choose another directory.

## Fleet and voyage foundations

The main-process host exposes these lane-scoped operations:

- `launch({ runtimeId, cwd, laneId? })` starts one lane and allocates a
  `lane-N` id when `laneId` is omitted.
- `launchFleet({ lanes })` reserves all ids and starts lanes concurrently; a
  failed launch rolls back the whole fleet.
- `fleet()` returns stable lane identities, current observer views, and active
  turn ids. `submit`, `abort`, and `closeLane` accept a lane id (the omitted
  lane on `submit`/`abort` targets the most recently launched lane for legacy
  callers).
- `subscribeLane(id, listener)` receives only that lane's events; the normal
  host subscription receives every event with its `laneId` attached.

Every launched lane gets one voyage file. Its four record kinds are owned by
`@botiverse/oar`: a header, each human submission, each untouched public
`SessionEvent`, and a final end marker. The recorder buffers events around an
asynchronous steer/queue decision so a submission is always written first;
vendor-native raw output and debug logs remain separate concerns.

## Regatta first slice

The launch screen also offers `Launch regatta · runtimeA + runtimeB` when at
least two runtimes are available. It starts the first two available runtimes
through `launchFleet` and opens a side-by-side view. Each lane keeps its own
session identity, status lamp, conversation, and Friendly/Raw Activity stream;
aborting one lane targets only that lane.

The shared composer sends one prompt to every lane concurrently and reports
partial delivery when a lane rejects or fails. The first slice keeps the
composer synchronized (it waits until every lane is idle) and deliberately
defers per-lane steering to a later Regatta slice. The `#smoke` renderer path
uses a deterministic Claude/Codex fixture, including one running lane and one
completed lane, so the two-column view is covered by the Xvfb screenshot smoke
without a login.

## Contract lens first slice

Every Activity panel continuously folds its untouched public `SessionEvent`
values through a consumer-side Contract lens. The first slice reports three
stream violations: a duplicate `turn_ended`, any event attributed to a turn
after its `turn_ended`, and a `receivedAt` timestamp that moves backwards
within one session/turn. It uses no runtime internals and deliberately does not
infer tool success or failure because `tool_call_ended` exposes no outcome bit.

An alarm count remains visible in the Activity header from either view. Switch
to Raw to see each expandable alarm directly after its offending event, with
lane, session, turn, sequence, timestamp, and invariant details. The
deterministic smoke fixture injects one late Codex event; that lane opens in Raw
so the alarm row is covered by the screenshot smoke without a login.

## Usage helm first slice

Each prompted turn gets a public `accountUsage` sample before the prompt and a
second sample after its `turn_ended` event. A queued/spontaneous turn gets the
same pair from its public `turn_started` boundary; steering an existing turn
does not create a misleading second pair. The renderer keeps the raw result
and derives label-matched window deltas, reset markers, burn rate, and a
reset-aware time-to-limit projection. Unsupported, unavailable, reauth, and
reader-error results remain visible as explicit states on the outcome row.

Reads are serialized per lane. If a lane closes while a public usage promise is
pending, close wins the observation race and emits an explicit error boundary
when needed; the underlying runtime promise is left to settle on its own, so
quota observation cannot hold disposal hostage.
The feature uses only the public OAR `accountUsage` capability; no runtime
internals or credentials cross the renderer boundary. Renderer-side observe
helpers use the documented browser-safe `@botiverse/oar/observe` export; the
lint rule rejects every other OAR deep path and direct source import.

## Checks

```sh
pnpm --filter @botiverse/coxswain check
pnpm --filter @botiverse/coxswain test
pnpm --filter @botiverse/coxswain build
```

The deterministic screenshot smoke needs an X display on Linux and uses the
CommonJS launcher documented in `design/README.md`:

```sh
xvfb-run -a pnpm --filter @botiverse/coxswain smoke
```

The screenshot is written to `artifacts/coxswain-smoke.png`.

To make shareable fixture-only artifacts (a PNG plus a short MP4 assembled
from deterministic `#smoke` frames), run this outside the commit check:

```sh
pnpm --filter @botiverse/coxswain showcase
```

The command supplies Xvfb automatically when no display is present and writes
to `apps/coxswain/artifacts/showcase/`. The showcase path never launches a
runtime or reads account usage, and requires `ffmpeg` for MP4 encoding.

## Manual dogfood path

1. Launch a locally logged-in Claude installation.
2. Send a prompt and verify that Friendly Activity uses semantic action labels
   while Raw shows the complete event stream one-for-one.
3. If a Contract lens warning appears, open Raw and verify that the alarm is
   attributed to the offending event, session, turn, and lane.
4. Verify that messages emitted with `say` appear in the conversation.
5. Send another input while the turn runs and inspect its steered/queued marker.
6. Watch the status lamp follow the OAR observer, then abort the turn.
7. On a completed turn, inspect the outcome row's Usage motion line: compare
   the per-window delta, burn rate, and reset/projection note with the runtime
   account-usage readings. A runtime that reports no usage should say so
   explicitly rather than showing a fabricated zero.
