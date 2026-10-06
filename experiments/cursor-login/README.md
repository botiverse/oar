# Cursor login against a local backend

**Run this on every `@cursor/sdk` upgrade**, before the new version ships:

```sh
pnpm tsx experiments/cursor-login/probe.ts [--keep]
```

It takes about 40 seconds and exits 0 only when every line is `PASS`.
`--keep` leaves the temporary homes in place for inspection.

## What it runs

The real `@cursor/sdk`, loaded the way a host loads it, signs in through
OAR's cursor `login` and `authStatus`
([login](../../packages/oar/src/runtimes/cursor/login.ts)). The backend it
talks to is [`mock-backend.ts`](mock-backend.ts), which serves only the
endpoints the 1.0.35 bundle calls: the browser page
`/loginDeepControl?challenge=…&uuid=…`, `POST /auth/poll` (it checks the
PKCE verifier against the page's challenge), and the Connect RPCs
`DashboardService/CreateUserApiKey` and `GetMe` (binary protobuf over
HTTP/1.1). The probe plays the person: it opens the URL from the `auth_url`
event, which signs that uuid in. No account and no network are needed.

- **Nothing real is touched.** Before the SDK loads, `HOME`, `USERPROFILE`,
  the `XDG_*` directories and `APPDATA`/`LOCALAPPDATA` point into a
  temporary directory (each scenario has its own home), `CURSOR_API_KEY` and
  proxy variables are unset, and `CURSOR_BACKEND_URL` and
  `CURSOR_WEBSITE_URL` point at the mock. Each scenario asserts that the
  SDK's own `getDefaultSdkAuthPath()` resolves inside its home.
- **Nothing leaves the machine.** Every outbound TCP connection (fetch,
  `node:http`, http2 and TLS all go through `net.Socket.prototype.connect`) to
  anything other than the mock is refused, and the run fails. A first check
  proves that the guard refuses fetch, `node:http` and `net.connect` to
  another address.
- **No secret is printed.** The mock hands out obviously fake keys and
  tokens. `auth.json` is reported only as a sha256 prefix, its mtime and
  mode; the probe also asserts that no key or token reaches an event or a
  result.
- **The SDK's login is teed, not altered.** OAR's options go to the real
  `Cursor.auth.login` as they are, and its own promise goes back to OAR. The
  probe keeps a copy of how it settled, because OAR drops the SDK's outcome
  after a stop.

## Scenarios

| Scenario | Expected |
| --- | --- |
| network guard | fetch, `node:http` and `net.connect` to `127.0.0.2` are refused |
| success | `logged_in` with the mock's email and `expiresAt` about 90 days out; `auth.json` written once, mode 0600, holding the minted key against the mock; `authStatus` reads the same account; one PKCE-verified poll flow, one `CreateUserApiKey` with the session token, one `GetMe`; the SDK prints neither the URL nor a warning (0 bytes observed) |
| cancel while polling (empty home, previous login) | `cancelled`; the SDK throws `Login was cancelled.` and polls no more; `auth.json` absent (and no `~/.cursor`), or byte for byte and mtime as it was |
| cancel while minting (empty home, previous login) | the mock holds `CreateUserApiKey`; the cancel is `cancelled`; once released, the SDK goes on to `GetMe` and tries to save, and OAR's store refuses it; `auth.json` as before |
| timeout while polling (both homes) | `timed_out` (2.5 s deadline); the SDK polls no more; `auth.json` as before |
| timeout while minting (both homes) | `timed_out` (4 s deadline) while the mint is held; the late save is refused; `auth.json` as before |

Every scenario also checks that the only event is one `auth_url` pointing at
the mock, that no prompt was asked, and that the SDK neither fell back to
`GET /auth/poll` nor called an endpoint the mock does not serve.

## When it fails

- `auth.json changed after a stop`: the SDK now writes outside the store it
  is given, or before the store's save. OAR's promise that `cancelled` and
  `timed_out` leave the previous login as it was no longer holds; don't ship
  the upgrade until the login's store is revisited. A negative control
  (handing the SDK its default store instead of OAR's) fails exactly the
  four mint-window scenarios with this message.
- `the SDK kept polling after the stop`: the SDK no longer honours its signal
  while it polls.
- `the SDK called an endpoint the mock does not serve`, a missing mint or
  `GetMe`, or a fallback to `GET /auth/poll`: the login flow changed. Read the
  new bundle (`dist/esm/index.js`, `Cursor.auth` and `src/agent/auth/*`),
  update the mock and the [runtime page](../../docs/runtimes/cursor.md#login),
  then rerun.
- `refused a connection to …`: the SDK tried to reach a host other than the
  mock (it ignored `CURSOR_BACKEND_URL`, or something new phones home).

Not covered: the real backend's behavior beyond these endpoints, a stop
while the file save itself runs (a local write; the
[unit tests](../../tests/login/cursor-login.test.ts) hold a save open), the
`GET /auth/poll` fallback, and Windows.

## Observed

2026-10-06, `@cursor/sdk` 1.0.35, Linux x64, Node 24, OAR at the cursor login
change ([#146](https://github.com/botiverse/oar/pull/146)): the guard check
and 9/9 scenarios passed, with no connection but the mock's. What OAR's login
assumes held on the real code: the SDK polls until the page is opened and
stops on the signal; it mints even after a cancel (the held
`CreateUserApiKey`, then `GetMe`) and only then saves, through the store it
was given, so OAR's refusal leaves `auth.json` untouched. It printed nothing
with `onLoginUrl` set. The refusal reaches the SDK's own rejection wrapped as
`UnknownAgentError: the login ended before cursor stored its key; nothing was
written`. The key's name is `Cursor SDK login (<hostname>)`, and its
`expires_at` is the `apiKeyExpiresAtMs` the SDK stores and `status()` reads
back.
