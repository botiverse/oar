"""Antigravity ACP logout, without any sign-in.

    python3 experiments/antigravity-login/logout-probe.py /absolute/path/to/agy

Starts `agy acp` in an empty temporary HOME holding only a placeholder
`antigravity-oauth-token` file (not a credential), sends `initialize`, prints
the declared auth capability and sign-in methods, sends `logout`, and reports
whether agy removed the placeholder. No Google account, code or network
sign-in is involved; the temporary HOME is deleted afterwards.
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

if len(sys.argv) < 2:
    sys.exit(__doc__)
binary = str(pathlib.Path(sys.argv[1]).resolve())
home = pathlib.Path(tempfile.mkdtemp(prefix="agy-logout-"))
token = home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
token.parent.mkdir(parents=True)
token.write_text('{"placeholder":"not-a-credential"}\n')
token.chmod(0o600)
child = subprocess.Popen([binary, "acp"], env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


def call(message_id, method, params):
    child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params}) + "\n")
    child.stdin.flush()
    for line in child.stdout:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("id") == message_id:
            return message
    return None


try:
    init = call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
    result = init.get("result", {}) if init else {}
    print("auth capability:", json.dumps(result.get("agentCapabilities", {}).get("auth")))
    print("sign-in methods:", [method.get("id") for method in result.get("authMethods", [])])
    print("logout answer:", json.dumps(call(2, "logout", {})))
    print("placeholder token file still there:", token.exists())
finally:
    child.kill()
    shutil.rmtree(home, ignore_errors=True)
