"""Antigravity login launcher and blank-input controls, without any sign-in.

    python3 experiments/antigravity-login/probe.py /absolute/path/to/agy [out.json] [--path-launcher]

Runs `agy acp --login` in an empty temporary HOME with BROWSER=true and a
simulated GNOME desktop (XDG_CURRENT_DESKTOP=GNOME, DISPLAY=:99). Harmless
sentinels named like browser launchers (and `gio`) record any call instead of
opening anything. With --path-launcher a sentinel `xdg-open` is also first on
PATH, as OAR does for `openBrowser: false`; without it the system `xdg-open`
(if installed) runs and may reach the `gio` sentinel. It sends one blank line,
checks agy is still waiting 800 ms later, then closes stdin. No code,
credential or network sign-in is used; the auth URL is omitted from output.
Based on Otter's PR #720 review script.
"""
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
path_launcher = "--path-launcher" in sys.argv
if not args:
    sys.exit(__doc__)
binary = str(pathlib.Path(args[0]).resolve())
out = pathlib.Path(args[1]) if len(args) > 1 else None

with tempfile.TemporaryDirectory(prefix="oar-agy-login-probe-") as temp:
    root = pathlib.Path(temp)
    bindir = root / "bin"
    bindir.mkdir()
    marker = root / "browser-called"
    names = ["sensible-browser", "gio", "x-www-browser", "google-chrome", "firefox"] + (["xdg-open"] if path_launcher else [])
    for name in names:
        sentinel = bindir / name
        sentinel.write_text(f"#!/bin/sh\nprintf '%s %s\\n' '{name}' \"$1\" >> '{marker}'\nexit 0\n")
        sentinel.chmod(0o755)
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin", "HOME": temp, "GEMINI_HOME": str(root / ".gemini"),
        "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
        "XDG_CACHE_HOME": str(root / "cache"), "XDG_STATE_HOME": str(root / "state"),
        "AGY_CLI_DISABLE_AUTO_UPDATE": "1", "BROWSER": "true", "LANG": "C.UTF-8",
        "XDG_CURRENT_DESKTOP": "GNOME", "DISPLAY": ":99",
    }
    proc = subprocess.Popen([binary, "acp", "--login"], env=env, cwd=root, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    poll = selectors.DefaultSelector()
    poll.register(proc.stdout, selectors.EVENT_READ)
    poll.register(proc.stderr, selectors.EVENT_READ)
    text = b""
    deadline = time.monotonic() + 5
    try:
        while b"Then paste the authorization code" not in text and time.monotonic() < deadline:
            for key, _ in poll.select(0.1):
                text += os.read(key.fd, 65536)
        prompt = b"Then paste the authorization code" in text
        proc.stdin.write(b"\n")
        proc.stdin.flush()
        time.sleep(0.8)
        after_blank = proc.poll()
        proc.stdin.close()
        proc.stdin = None
        stdout, stderr = proc.communicate(timeout=5)
        text += stdout + stderr
        calls = marker.read_text().splitlines() if marker.exists() else []
        result = {
            "agy": subprocess.run([binary, "--version"], env=env, capture_output=True, text=True, timeout=10).stdout.strip(),
            "pathLauncher": path_launcher,
            "promptReached": prompt,
            "exitAfterBlankLineAnd800ms": after_blank,
            "exitAfterInputClosed": proc.returncode,
            "browserCalls": [re.sub(r"https://\S+", "[auth URL omitted]", call) for call in calls],
            "output": re.sub(r"https://\S+", "[auth URL omitted]", text.decode()),
        }
        rendered = json.dumps(result, indent=1)
        if out is not None:
            out.write_text(rendered + "\n")
        print(rendered)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
