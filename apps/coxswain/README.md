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

## Manual dogfood path

1. Launch a locally logged-in Claude installation.
2. Send a prompt and verify that Friendly Activity uses semantic action labels
   while Raw shows the complete event stream one-for-one.
3. Verify that messages emitted with `say` appear in the conversation.
4. Send another input while the turn runs and inspect its steered/queued marker.
5. Watch the status lamp follow the OAR observer, then abort the turn.
