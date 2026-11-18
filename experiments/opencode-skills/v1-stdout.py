"""Compare v1 debug skill pipe and file output without publishing skill content."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def observation(completed, output):
    try:
        parsed = json.loads(output)
        shape = {"validJson": True, "items": len(parsed) if isinstance(parsed, list) else None}
    except (ValueError, UnicodeDecodeError):
        shape = {"validJson": False, "items": None}
    return {"exitCode": completed.returncode, "stdoutBytes": len(output),
            "stderrBytes": len(completed.stderr), **shape}


binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="oar-opencode-pipe-") as temporary:
    root = Path(temporary)
    home, cwd = root / "home", root / "empty"
    home.mkdir()
    cwd.mkdir()
    skill = home / ".agents/skills/large/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: large\ndescription: Synthetic output-size fixture\n---\n" + "x" * (512 * 1024))
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "TEMP", "TMP") if key in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(root / "config"),
               XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
               XDG_STATE_HOME=str(root / "state"), OPENCODE_DISABLE_AUTOUPDATE="true",
               OPENCODE_DISABLE_MODELS_FETCH="true", NO_COLOR="1")
    version = subprocess.run([binary, "--version"], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             capture_output=True, check=True, timeout=30).stdout.decode().strip()
    rows = []
    for attempt in range(3):
        piped = subprocess.run([binary, "debug", "skill"], cwd=cwd, env=env,
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        with tempfile.TemporaryFile() as output:
            filed = subprocess.run([binary, "debug", "skill"], cwd=cwd, env=env,
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.PIPE, timeout=30)
            output.seek(0)
            rows.append({"attempt": attempt + 1, "pipe": observation(piped, piped.stdout),
                         "file": observation(filed, output.read())})
    print(json.dumps({"version": version, "platform": sys.platform, "bodyBytes": 512 * 1024,
                      "credentialEnvironmentInherited": False, "samples": rows}, indent=2))
