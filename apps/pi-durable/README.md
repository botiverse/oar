# Pi Durable browser demo

A small OAR host that runs the real Pi Durable Harness inside a browser.
It uses `MemoryStorage`, the native Anthropic fetch provider, and OAR's
portable browser core and the separate `@botiverse/oar/pi-durable` entry.
`observeSessionView` folds each record once and supplies the rendered
`SessionView`; closing the session cancels the subscription.
There is no tool registry, filesystem access or server-side agent.

From the repository root, with Node.js 24+ and pnpm installed:

```sh
pnpm install
pnpm durable-demo
```

Open `http://127.0.0.1:4748`. Enter your own Anthropic API key, choose a
model available to that account, and start a conversation. The list is the
provider's native catalog; listing a model does not establish account access.
Sending messages makes billable requests directly from the browser to
Anthropic. Its native SDK enables direct browser access; no model request or
key passes through the local static server.

The key stays in memory and its form field clears after opening the session.
Neither the key nor the conversation is written to browser storage. Reloading
loses the conversation. **Stop** aborts the native run. **End session** aborts,
disposes the OAR controller, and closes the host-owned Harness. This explicit
cleanup matters because an OAR Durable controller's `dispose()` alone only
stops observing; it does not stop shared execution.

`app.ts` owns the Harness and the same Models instance given to
`createPiDurableRuntime`, and subscribes with `observeSessionView`.
`render.ts` renders each supplied view with `textContent`.
`host.ts` bundles the portable entry and
serves static assets on loopback. The source import keeps this repository
example runnable before publishing; an installed host imports
`@botiverse/oar/browser` for the core and `@botiverse/oar/pi-durable` for
the factory, and supplies the optional Durable/Chord peers.

## Browser smoke test

```sh
pnpm exec playwright install chromium
pnpm durable-demo:smoke
```

The smoke test runs Chromium with the real Harness, OAR adapter and native
fetch provider. Playwright redirects provider HTTP to a local aimock server
and supplies only a synthetic test key. It verifies a completed conversation,
literal rendering of model-supplied HTML, abort, session cleanup, and absence
of saved browser data. It uses no account, login or model quota. CI runs this
test on Linux; the portable-entry bundle gate also runs on all three systems.
