#!/usr/bin/env python3
"""No-account Codex/Grok catalog control. Publishes fixture metadata, never skill bodies."""

import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


def rpc(process, request, seconds=30):
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    deadline = time.monotonic() + seconds
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("Native app-server exited before replying")
            message = json.loads(line)
            if message.get("id") == request["id"]:
                if "error" in message:
                    raise RuntimeError("Native app-server rejected query")
                return message["result"]
        raise TimeoutError("Native inventory timed out")
    finally:
        selector.close()


def run(runtime, command):
    with tempfile.TemporaryDirectory(prefix="oar-invocability-") as temporary:
        root = Path(temporary)
        home, cwd = root / "home", root / "project"
        home.mkdir()
        cwd.mkdir()
        (cwd / ".git").mkdir()
        (home / ".codex").mkdir()
        env = {
            key: os.environ[key]
            for key in ("PATH", "SystemRoot", "TEMP", "TMP")
            if key in os.environ
        }
        env.update(
            HOME=str(home),
            USERPROFILE=str(home),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_CACHE_HOME=str(home / ".cache"),
            XDG_DATA_HOME=str(home / ".data"),
            CODEX_HOME=str(home / ".codex"),
            GROK_HOME=str(home / ".grok"),
            HTTP_PROXY="http://127.0.0.1:9",
            HTTPS_PROXY="http://127.0.0.1:9",
            ALL_PROXY="http://127.0.0.1:9",
            NO_PROXY="127.0.0.1,localhost",
            CI="1",
        )
        skill_root = home / (".agents" if runtime == "codex" else ".grok") / "skills"
        fixtures = {
            "oar-invocability-default": "",
            "oar-invocability-enabled": "user-invocable: true\n",
            "oar-invocability-hidden": "user-invocable: false\n",
            "oar-invocability-manual": "disable-model-invocation: true\n",
        }
        for name, flags in fixtures.items():
            directory = skill_root / name
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: Synthetic invocation fixture\n{flags}---\nPRIVATE_BODY\n"
            )
        version = subprocess.run(
            [command, "--version"],
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
        )
        if version.returncode:
            raise RuntimeError("Native version query failed")
        if runtime == "grok":
            native = subprocess.run(
                [command, "inspect", "--json"],
                cwd=cwd,
                env=env,
                text=True,
                capture_output=True,
                timeout=30,
            )
            if native.returncode:
                raise RuntimeError("Native inspect failed")
            rows = json.loads(native.stdout)["skills"]
        else:
            with (root / "stderr").open("w") as stderr:
                process = subprocess.Popen(
                    [command, "app-server", "--listen", "stdio://"],
                    cwd=cwd,
                    env=env,
                    text=True,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=stderr,
                )
                try:
                    rpc(
                        process,
                        {
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "clientInfo": {
                                    "name": "oar-invocability",
                                    "version": "0.0.0",
                                },
                                "capabilities": {"experimentalApi": True},
                            },
                        },
                    )
                    process.stdin.write(
                        json.dumps({"method": "initialized", "params": {}}) + "\n"
                    )
                    process.stdin.flush()
                    native = rpc(
                        process,
                        {
                            "id": 2,
                            "method": "skills/list",
                            "params": {"cwds": [str(cwd)]},
                        },
                    )
                    rows = [
                        skill for entry in native["data"] for skill in entry["skills"]
                    ]
                except Exception as error:
                    stderr.flush()
                    raise RuntimeError((root / "stderr").read_text()[:2000]) from error
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
        selected = []
        for row in rows:
            if row.get("name") not in fixtures:
                continue
            selected.append(
                {
                    "name": row["name"],
                    "fields": sorted(row),
                    **{
                        key: row[key]
                        for key in ("userInvocable", "invocableAs", "enabled", "policy")
                        if key in row
                    },
                }
            )
        assert {row["name"] for row in selected} == set(
            fixtures
        ), "Missing native fixture"
        return {
            "runtime": runtime,
            "version": version.stdout.strip(),
            "fixtures": fixtures,
            "catalogCount": len(rows),
            "selected": selected,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("runtime", choices=["codex", "grok"])
    parser.add_argument("command")
    parser.add_argument("output")
    args = parser.parse_args()
    Path(args.output).write_text(
        json.dumps(run(args.runtime, args.command), indent=2) + "\n"
    )
