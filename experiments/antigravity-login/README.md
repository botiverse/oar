# Antigravity login: launcher and blank input

agy 1.5.5, Linux, isolated empty HOME, harmless sentinels; no Google sign-in,
code or credential.

```sh
python3 experiments/antigravity-login/probe.py /absolute/path/to/agy [out.json]                  # system xdg-open (needs one installed)
python3 experiments/antigravity-login/probe.py /absolute/path/to/agy [out.json] --path-launcher  # OAR's openBrowser: false shim
```

The first form reproduces the `gio open` call on a machine with
`/usr/bin/xdg-open` (observed by Otter in the PR #720 review); this machine
has none, so only the second form was rerun here.

| Control | Result |
|---|---|
| `BROWSER=true`, real `/usr/bin/xdg-open`, simulated GNOME (Otter) | agy still runs `xdg-open`, which takes its `gio open` branch: `BROWSER` does not suppress it |
| A sentinel `xdg-open` first on PATH (what OAR sets for `openBrowser: false`), same environment | agy runs the sentinel with the URL; neither the system `xdg-open` nor `gio` runs ([selected](path-launcher-selected.json)) |
| A blank line on stdin | agy keeps waiting (still running 800 ms later) |
| stdin closed without an answer | exit 1, `login cancelled: no authorization code was entered` |

So OAR suppresses the browser by replacing the launcher agy finds on PATH,
and never sends a blank answer (it asks again). A full authenticated sign-in
through OAR, and Windows/macOS launchers, are not verified here.

## Logout

agy 1.5.5, Linux, 2026-11-11, an empty temporary HOME holding only a
placeholder `antigravity-oauth-token` file:

```sh
python3 experiments/antigravity-login/logout-probe.py /absolute/path/to/agy
```

```text
auth capability: {"logout": {}}
sign-in methods: ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform']
logout answer: {"jsonrpc": "2.0", "result": {}, "id": 2}
placeholder token file still there: False
```

`agy acp` declares ACP `logout` and removes the stored token file itself, so
OAR's `logout` sends it and reads `agy models` afterwards. Not observed: a
keyring-stored sign-in, and whether agy revokes the grant at Google. The
same `initialize` also lists sign-in methods besides Google
(`oauth-business`, `gemini-api-key`, `agent-platform`), which OAR does not
drive.
