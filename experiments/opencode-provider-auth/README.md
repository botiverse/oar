# OpenCode 2 provider sign-in

What `opencode serve` 2.2.7 exposes for per-provider sign-in, and what
`createOpencodeProviderAuth` does with it. Every run used an isolated HOME,
no TTY, synthetic keys, and no account: no sign-in was completed.

```sh
pnpm tsx experiments/opencode-provider-auth/probe.ts /path/to/opencode oar-trial-run/opencode-provider-auth
pnpm tsx experiments/opencode-provider-auth/native-checks.ts /path/to/opencode oar-trial-run/opencode-native-checks
```

The probe creates the facade with `HOME` in the new output directory, reads
the registry, stores two synthetic xAI keys, tries `setApiKey` on Azure,
signs xAI out, starts the GitHub Copilot and xAI OAuth flows, cancelling
each as soon as its device code arrives (OpenCode contacts GitHub and xAI to
create the codes), starts the five browser methods and cancels each at its
URL, times a call after `close()`, and then repeats the browser methods and
xAI on a second facade with `loopback: "refuse"`. It writes
`observations.json`; device codes are replaced by `<code>` and authorize URLs
are reduced to origin, path and `redirect_uri`.
[Retained observations](evidence.json) contain no credential values or
local paths.

The native checks (POSIX) start a raw `opencode serve` with
`OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1` and
`BROWSER` pointing at a script that records each call, read its readiness,
registry size and the answer to a wrong password, connect and cancel six
browser methods, and count the `BROWSER` calls; then a host process creates
the facade and SIGKILLs itself, and the check counts surviving
`opencode serve` processes. [Retained results](native-checks.json).

## Observed on Linux arm64, 2026-11-11

Package `@opencode/cli@2.2.7` (`opencode v2.2.7`), installed with npm into a
scratch prefix.

- **Startup.** `opencode serve --hostname 127.0.0.1 --port 0` prints
  `server listening on http://127.0.0.1:<port>` and, with no password in its
  environment, `server password <value>`. With `OPENCODE_PASSWORD` (read
  first) or `OPENCODE_SERVER_PASSWORD` set it prints only the first line;
  basic auth is user `opencode` with that password. The bundled source also
  has a helper that leaves both variables out when it copies the
  environment (read, not exercised). The bundle has no
  `OPENCODE_SERVER_USERNAME`: the user is fixed. A wrong password answers
  `401 {"_tag":"UnauthorizedError","message":"Authentication required"}`.
- **Environment flags.** The 2.2.7 bundle reads
  `OPENCODE_DISABLE_AUTOUPDATE` (its update check, `1` or `true`) and
  `OPENCODE_DISABLE_MODELS_FETCH` (passed to the server as
  `models.fetch: false`). With both set, readiness took 1.2 to 1.4 s and the
  registry still listed 239 integrations. OAR sets both for its serve child.
- **Browser.** With `BROWSER` set to a recording script, connecting six
  browser methods ran it zero times: on 2.2.7 the server returns the URL and
  opens nothing itself. OAR still sets `BROWSER=true` on POSIX.
- **Host death.** A host SIGKILLed right after creating the facade: its
  `opencode serve` was still running at once and gone three seconds later
  (the watchdog OAR runs it under stopped it).
- **Readiness.** `GET /api/integration` answered 200 with no entries for
  about 0.6 s, then 233 key/env-only entries, then the plugin methods (10
  OAuth) at about 0.85 to 1.2 s, then 239 entries. `GET /api/plugin` stayed
  empty until the registry was complete in every run (92 active built-in
  plugins), so OAR waits until both lists are non-empty. Creating the facade
  took 1.6 to 2.5 s on a fresh HOME, and a call after `close()` (a new
  server) 1.4 s.
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
- **Form fields.** `/openapi.json` types a form field as `string` (formats
  `email`, `uri`, `date`, `date-time`), `number`, `integer`, `boolean`,
  `multiselect` or `external`; there is no secret type, and every field in
  the 2.2.7 registry is a `string`. OAR therefore asks none as `secret`.
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
  `redirect_uri` is a loopback address on the machine running
  `opencode serve`: OpenAI `chatgpt-token-sharing`
  `http://127.0.0.1:<port>/auth/callback`, `chatgpt-browser`
  `http://localhost:1455/auth/callback`, GitLab
  `http://127.0.0.1:8080/callback`, Poe `http://127.0.0.1:<port>/callback`,
  DigitalOcean `http://localhost:1456/auth/callback` and Snowflake Cortex
  `http://127.0.0.1:<port>/`. With `loopback: "refuse"` the facade rejected
  each of the first five with `loopback_required` and cancelled it; xAI's
  device flow was unaffected. Attempts expire after 600 s (xAI 1800 s);
  status reads `pending` until then. After `cancel`, status answers 404
  `IntegrationAttemptNotFoundError`. Connecting GitLab and the OpenCode
  console without their optional or hidden fields succeeded with URLs for
  the default hosts.

## Not observed

- A completed sign-in of any method, and therefore the stored OAuth
  connection's label and method after completion (the unit fixture assumes
  `method: "oauth"`, as the schema says), and whether it is stored as a new
  credential or updates one (OAR removes earlier credentials only when a new
  one appears).
- An attempt with `mode: "code"` or `paste: true`. The bundled source sets
  `paste` when an `auto` method also accepts a submitted code; OAR's handling
  of both comes from the schema and source and is covered only by the fake
  server.
- `failed` and `expired` statuses from the real server.
- Windows and macOS, including the watchdog's `taskkill` path.
