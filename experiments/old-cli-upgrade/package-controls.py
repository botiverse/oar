"""Isolated Pi self-update and DSH command inventory, with no account/model calls."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="oar-old-package-") as directory:
    root = Path(directory)
    env = {k: v for k, v in os.environ.items() if k in
           ("PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")}
    env.update(HOME=directory, USERPROFILE=directory, PI_TELEMETRY="0",
               DSH_HOME=str(root / "dsh"), npm_config_prefix=str(root / "prefix"),
               npm_config_cache=str(root / "cache"))
    npm = "npm.cmd" if os.name == "nt" else "npm"
    install = subprocess.run([npm, "install", "--global", "--no-audit", "--no-fund",
                              "@earendil-works/pi-coding-agent@1.3.0", "@deepseek-ai/dsh@0.2.1-rc.4"],
                             env=env, cwd=root, stdin=subprocess.DEVNULL, capture_output=True,
                             text=True, timeout=240, check=True)
    results = []
    for name, args in [("pi", ["--version"]), ("pi", ["update", "--help"]),
                       ("pi", ["update", "--self", "--no-approve"]), ("pi", ["--version"]),
                       ("dsh", ["--version"]), ("dsh", ["--help"])]:
        executable = root / "prefix" / (name + ".cmd") if os.name == "nt" else root / "prefix/bin" / name
        run = subprocess.run([str(executable), *args], env=env, cwd=root,
                             stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
        results.append({"command": [name, *args], "exitCode": run.returncode,
                        "stdout": run.stdout.replace(directory, "<isolated>"),
                        "stderr": run.stderr.replace(directory, "<isolated>")})
    print(json.dumps(results, indent=2))
