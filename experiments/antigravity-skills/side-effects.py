"""Linux native query evidence: isolated state, synthetic key, no model endpoint.

Usage: python3 experiments/antigravity-skills/side-effects.py BINARY OUTPUT_DIR
Requires strace. Network traces and full file fingerprints stay in OUTPUT_DIR.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(home):
    files = {}
    for path in sorted(home.rglob("*")):
        if not path.is_file():
            continue
        raw = path.read_bytes()
        row = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        if raw[:16] == b"SQLite format 3\x00":
            db = sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True)
            try:
                row["tables"] = {
                    name: db.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
                    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
            finally:
                db.close()
        files[str(path.relative_to(home))] = row
    return files


results = []
with tempfile.TemporaryDirectory(prefix="oar-agy-skill-effects-") as temporary:
    root = Path(temporary)
    home, cwd = root / "home", root / "workspace"
    home.mkdir()
    cwd.mkdir()
    launch = root / "launch"
    launch.mkdir()
    browser = launch / "xdg-open"
    browser.write_text("#!/bin/sh\nexit 0\n")
    browser.chmod(0o755)
    env = {"PATH": str(launch) + os.pathsep + os.environ["PATH"], "HOME": str(home),
           "USERPROFILE": str(home), "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(root / "missing-bus"),
           "AGY_CLI_DISABLE_AUTO_UPDATE": "true"}
    for name in ["CONFIG", "DATA", "STATE", "CACHE"]:
        env["XDG_" + name + "_HOME"] = str(root / name.lower())
    version = subprocess.check_output([str(binary), "--version"], env=env, text=True, timeout=15).strip()
    before_binary = digest(binary)
    for mode in ["signed-out-models", "configured-cold-skills", "configured-warm-skills"]:
        if mode == "configured-cold-skills":
            config = home / ".gemini/antigravity-cli/settings.json"
            config.parent.mkdir(parents=True, exist_ok=True)
            config.write_text(json.dumps({"modelProvider": "gemini", "setupComplete": True, "onboardingComplete": True}))
            env.update(GEMINI_API_KEY="synthetic", GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:9")
        args = ["models"] if mode == "signed-out-models" else ["--output-format", "json", "--print=/skills"]
        before = snapshot(home)
        trace = output / (mode + ".strace")
        child = subprocess.Popen(["strace", "-f", "-e", "trace=network,read,write", "-s", "1024", "-o", str(trace), str(binary), *args],
                                 cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        timed_out = False
        try:
            stdout, stderr = child.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGKILL)
            stdout, stderr = child.communicate()
        after = snapshot(home)
        row = {"mode": mode, "args": args, "exit": child.returncode, "timedOut": timed_out,
               "stdout": stdout, "stderr": stderr, "before": before, "after": after,
               "binaryUnchanged": digest(binary) == before_binary,
               "networkTraceSha256": digest(trace)}
        results.append(row)
        assert row["binaryUnchanged"], "Native query changed the executable"
    (output / "result.json").write_text(json.dumps({"version": version, "binarySha256": before_binary, "results": results}, indent=2).replace(str(root), "<fixture>"))
print(json.dumps({"version": version, "output": str(output), "exits": [row["exit"] for row in results]}))
