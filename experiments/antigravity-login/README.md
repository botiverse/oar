# Antigravity login: launcher and blank input

agy 1.5.5, Linux, isolated empty HOME, harmless sentinels; no Google sign-in,
code or credential. Reproduction: Otter's `pr720-direct-native-repro.py`
(PR #720 review thread) with `xdg-open` added to its sentinel directory.

| Control | Result |
|---|---|
| `BROWSER=true`, real `/usr/bin/xdg-open`, simulated GNOME (Otter) | agy still runs `xdg-open`, which takes its `gio open` branch: `BROWSER` does not suppress it |
| A sentinel `xdg-open` first on PATH (what OAR sets for `openBrowser: false`), same environment | agy runs the sentinel with the URL; neither the system `xdg-open` nor `gio` runs ([selected](path-launcher-selected.json)) |
| A blank line on stdin | agy keeps waiting (still running 800 ms later) |
| stdin closed without an answer | exit 1, `login cancelled: no authorization code was entered` |

So OAR suppresses the browser by replacing the launcher agy finds on PATH,
and never sends a blank answer (it asks again). A full authenticated sign-in
through OAR, and Windows/macOS launchers, are not verified here.
