#!/usr/bin/env python3
"""Isolated native Kimi/OpenCode catalogs. No session, account or model request."""

import argparse, json, os, re, secrets, selectors, subprocess, tempfile, time
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler


def run(runtime, command, collision=False):
    with tempfile.TemporaryDirectory(prefix="oar-invocability-web-") as tmp:
        root = Path(tmp)
        home = root / "home"
        cwd = root / "project"
        home.mkdir()
        cwd.mkdir()
        (cwd / ".git").mkdir()
        env = {
            k: os.environ[k]
            for k in ("PATH", "SystemRoot", "TEMP", "TMP")
            if k in os.environ
        }
        env.update(
            HOME=str(home),
            USERPROFILE=str(home),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_DATA_HOME=str(home / ".data"),
            XDG_CACHE_HOME=str(home / ".cache"),
            XDG_STATE_HOME=str(home / ".state"),
            KIMI_CODE_HOME=str(home / ".kimi"),
            OPENCODE_DISABLE_AUTOUPDATE="true",
            OPENCODE_DISABLE_MODELS_FETCH="true",
            NO_COLOR="1",
            HTTP_PROXY="http://127.0.0.1:9",
            HTTPS_PROXY="http://127.0.0.1:9",
            ALL_PROXY="http://127.0.0.1:9",
            NO_PROXY="localhost,127.0.0.1",
        )
        fixtures = {
            "oar-default": "",
            "oar-hidden": "user-invocable: false\n",
            "oar-invocable": "user-invocable: true\n",
            "oar-manual": "disable-model-invocation: true\n",
        }
        for name, flags in fixtures.items():
            directory = cwd / ".agents" / "skills" / name
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: Invocation control\n{flags}---\nPRIVATE BODY\n"
            )
        if collision:
            folder = cwd / ".opencode" / "commands"
            folder.mkdir(parents=True)
            (folder / "oar-default.md").write_text(
                "---\ndescription: Custom command collision\n---\nCUSTOM COMMAND\n"
            )
        version = subprocess.run(
            [command, "--version"],
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
        )
        assert version.returncode == 0
        timings = {}
        if runtime == "opencode-v1":
            started = time.monotonic()
            with (root / "catalog.json").open("w") as stdout:
                native = subprocess.run(
                    [command, "debug", "skill"],
                    cwd=cwd,
                    env=env,
                    stdout=stdout,
                    stderr=subprocess.PIPE,
                    timeout=30,
                )
            timings["debugSkillMs"] = (time.monotonic() - started) * 1000
            assert native.returncode == 0
            rows = json.loads((root / "catalog.json").read_text())
        if runtime in ("kimi", "opencode-v1", "opencode-v2"):
            password = secrets.token_urlsafe(24)
            if runtime.startswith("opencode"):
                env["OPENCODE_SERVER_PASSWORD"] = password
                args = ["serve", "--hostname", "127.0.0.1", "--port", "0"]
            else:
                args = ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"]
            with (root / "stderr").open("w") as stderr:
                started = time.monotonic()
                child = subprocess.Popen(
                    [command, *args],
                    cwd=cwd,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=stderr,
                )
                try:
                    selector = selectors.DefaultSelector()
                    selector.register(child.stdout, selectors.EVENT_READ)
                    deadline = time.monotonic() + 30
                    buffer = b""
                    origin = None
                    token = None
                    while time.monotonic() < deadline:
                        if not selector.select(max(0, deadline - time.monotonic())):
                            break
                        data = os.read(child.stdout.fileno(), 65536)
                        if not data:
                            break
                        buffer += data
                        match = re.search(
                            rb"http://127\.0\.0\.1:(\d+)(?:/?#token=([^\s\x1b]+))?",
                            buffer,
                        )
                        if match and (runtime.startswith("opencode") or match.group(2)):
                            origin = "http://127.0.0.1:" + match.group(1).decode()
                            token = match.group(2)
                            break
                    selector.close()
                    assert origin, "Native Web startup failed"
                    timings["serverReadyMs"] = (time.monotonic() - started) * 1000
                    opener = build_opener(ProxyHandler({}))

                    def query(path, body=None):
                        import base64

                        auth = (
                            ("Bearer " + token.decode())
                            if runtime == "kimi"
                            else "Basic "
                            + base64.b64encode(
                                ("opencode:" + password).encode()
                            ).decode()
                        )
                        req = Request(
                            origin + path,
                            data=None if body is None else json.dumps(body).encode(),
                            headers={
                                "Authorization": auth,
                                "Content-Type": "application/json",
                                "x-opencode-directory": str(cwd),
                            },
                        )
                        with opener.open(req, timeout=30) as response:
                            payload = json.load(response)
                            return (
                                payload.get("data", payload)
                                if isinstance(payload, dict)
                                else payload
                            )

                    if runtime == "kimi":
                        workspace = query("/api/v1/workspaces", {"root": str(cwd)})
                        rows = query(
                            "/api/v1/workspaces/" + workspace["id"] + "/skills"
                        )["skills"]
                    elif runtime == "opencode-v2":
                        query("/api/provider")
                        query("/api/plugin")
                        rows = query("/api/skill")
                    timings["beforeCommandMs"] = (time.monotonic() - started) * 1000
                    command_started = time.monotonic()
                    commands = []
                    if runtime.startswith("opencode"):
                        commands = query(
                            "/api/command" if runtime == "opencode-v2" else "/command"
                        )
                    else:
                        commands = query("/openapi.json")
                        commands = [
                            {"name": path, "methods": list(value)}
                            for path, value in commands.get("paths", {}).items()
                            if "command" in path or "skill" in path
                        ]
                    timings["commandQueryMs"] = (
                        time.monotonic() - command_started
                    ) * 1000
                    timings["serverThroughCommandMs"] = (
                        time.monotonic() - started
                    ) * 1000
                finally:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
        selected = [
            {
                "name": row["name"],
                "fields": sorted(row),
                **{
                    k: row[k]
                    for k in (
                        "userInvocable",
                        "user_invocable",
                        "autoinvoke",
                        "disable_model_invocation",
                        "enabled",
                    )
                    if k in row
                },
            }
            for row in rows
            if row.get("name") in fixtures
        ]
        assert len(selected) == len(
            fixtures
        ), "Native did not discover all invocation controls"
        return {
            "runtime": runtime,
            "version": version.stdout.strip(),
            "fixtures": fixtures,
            "selected": selected,
            "catalogCount": len(rows),
            "commandCollision": collision,
            "timings": timings,
            "commands": [
                {
                    "name": r.get("name"),
                    "fields": sorted(r),
                    **{k: r[k] for k in ["source", "skill", "methods"] if k in r},
                }
                for r in commands
            ],
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("runtime", choices=["kimi", "opencode-v1", "opencode-v2"])
    parser.add_argument("command")
    parser.add_argument("output")
    parser.add_argument("--collision", action="store_true")
    args = parser.parse_args()
    Path(args.output).write_text(
        json.dumps(run(args.runtime, args.command, args.collision), indent=2) + "\n"
    )
