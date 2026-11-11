# OpenCode 2 provider sign-in

What `opencode serve` 2.2.7 exposes for per-provider sign-in, and what
`createOpencodeProviderAuth` does with it. Every run used an isolated HOME,
no TTY, synthetic keys, and no account: no sign-in was completed.

```sh
pnpm tsx experiments/opencode-provider-auth/probe.ts /path/to/opencode oar-trial-run/opencode-provider-auth
```

The probe creates the facade with `HOME` in the new output directory, reads
the registry, stores two synthetic xAI keys, tries `setApiKey` on Azure,
signs xAI out, and starts the GitHub Copilot and xAI OAuth flows, cancelling
each as soon as its device code arrives (OpenCode contacts GitHub and xAI to
create the codes). It writes `observations.json`; device codes are replaced
by `<code>`. [Retained observations](evidence.json) contain no credential
values or local paths.

## Observed on Linux arm64, 2026-11-11

Package `@opencode/cli@2.2.7` (`opencode v2.2.7`), installed with npm into a
scratch prefix.

- **Startup.** `opencode serve --hostname 127.0.0.1 --port 0` prints
  `server listening on http://127.0.0.1:<port>` and, with no password in its
  environment, `server password <value>`. With `OPENCODE_PASSWORD` (read
  first) or `OPENCODE_SERVER_PASSWORD` set it prints only the first line;
  basic auth is user `opencode` with that password. The bundled source also
  has a helper that leaves both variables out when it copies the
  environment (read, not exercised).
- **Readiness.** `GET /api/integration` answered 200 with no entries for
  about 0.6 s, then 233 key/env-only entries, then the plugin methods (10
  OAuth) at about 0.85 to 1.2 s, then 239 entries. `GET /api/plugin` stayed
  empty until the registry was complete in every run (92 active built-in
  plugins), so OAR waits until both lists are non-empty. Creating the facade
  took 2.2 to 2.5 s on a cold HOME.
- **Operations** (`/openapi.json`, 170 operations): `integration.list`
  `GET /api/integration`, `integration.get` `GET /api/integration/{id}`,
  `integration.connect.key` `POST .../connect/key`, `integration.oauth.connect`
  `POST .../connect/oauth`, `integration.oauth.status`
  `GET .../connect/oauth/{attemptID}`, `integration.oauth.cancel`
  `DELETE` on the same path, `integration.oauth.complete`
  `POST .../complete`, and `credential.remove` `DELETE /api/credential/{id}`.
  `credential.list` returns the stored key values, so OAR never calls it.
- **Methods.** OAuth methods: DigitalOcean, GitHub Copilot (device, with a
  deployment form), GitLab (PKCE, optional instance URL with a default),
  OpenAI (`chatgpt-token-sharing`, `chatgpt-browser`, `chatgpt-headless`),
  OpenCode console (device, hidden server field with a default), Poe,
  Snowflake Cortex (form) and xAI (device). `external` methods: Amazon
  Bedrock, Claude Agent (its only method) and Google Vertex. Key forms:
  Azure, the two Cloudflare integrations and Snowflake Cortex. 238 of 239
  integrations have a usable method.
- **Keys.** `connect.key` answered 204 without validating. A second key adds
  a second credential (newest listed first); its label defaults to the
  integration name and is made unique (`xAI 2`). `DELETE /api/credential/{id}`
  answered 204, also for an id it did not have. A missing form field is
  `400 {"_tag":"InvalidRequestError","message":"Missing required form field: resourceName"}`;
  a key on an integration with no `key` method answered 500 with no body.
- **OAuth attempts.** Every probed method answered `mode: "auto"` with no
  `paste`. Device methods put the code in `instructions`
  (`Enter code: X`; xAI: `Open https://accounts.x.ai/oauth2/device on any
  device and enter code: X`). Browser methods return an authorize URL whose
  redirect is a loopback port on the machine running `opencode serve`.
  Attempts expire after 600 s (xAI 1800 s); status reads `pending` until
  then. After `cancel`, status answers 404 `IntegrationAttemptNotFoundError`.
  Connecting GitLab and the OpenCode console without their optional or
  hidden fields succeeded with URLs for the default hosts.

## Not observed

- A completed sign-in of any method, and therefore the stored OAuth
  connection's label and method after completion (the unit fixture assumes
  `method: "oauth"`, as the schema says).
- An attempt with `mode: "code"` or `paste: true`. The bundled source sets
  `paste` when an `auto` method also accepts a submitted code; OAR's handling
  of both comes from the schema and source and is covered only by the fake
  server.
- `failed` and `expired` statuses from the real server; whether
  `opencode serve` opens a browser itself for browser methods.
- Windows and macOS.
