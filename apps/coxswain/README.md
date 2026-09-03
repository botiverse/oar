# coxswain

An intentionally small Electron cockpit for dogfooding `@botiverse/oar`.
It runs one local agent per window: humans inject through `prompt` or
`steerOrQueue`, while agent replies enter the conversation only through the
temporary `say` CLI. The complete OAR event stream remains visible in the
Activity panel: Friendly is the default semantic timeline and folds each tool
call into one running/done row; Raw keeps every OAR event one-for-one with its
complete JSON available on expansion.

Where the cockpit is headed — the ambitious dogfooding-and-verification
feature set and its build order — lives in [`ROADMAP.md`](ROADMAP.md).

## Run

```sh
pnpm --filter @botiverse/coxswain dev
```

Choose an available runtime, optionally provide its native model identifier,
and choose an existing working directory. Closing the window disposes the
session and removes the temporary `say` bridge.

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
