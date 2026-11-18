#!/usr/bin/env python3
"""Compare bundled Pi SDK resources and its native RPC command catalog, without a prompt."""

import json, os, selectors, subprocess, tempfile, time, sys
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
package = repo / "node_modules/@earendil-works/pi-coding-agent"
version = json.loads((package / "package.json").read_text())["version"]
with tempfile.TemporaryDirectory(prefix="oar-invocability-pi-") as temp:
    root = Path(temp)
    home = root / "home"
    cwd = root / "project"
    agent = home / ".pi/agent"
    home.mkdir()
    cwd.mkdir()
    agent.mkdir(parents=True)
    env = {
        k: os.environ[k]
        for k in ("PATH", "SystemRoot", "TEMP", "TMP")
        if k in os.environ
    }
    env.update(
        HOME=str(home),
        USERPROFILE=str(home),
        PI_CODING_AGENT_DIR=str(agent),
        HTTP_PROXY="http://127.0.0.1:9",
        HTTPS_PROXY="http://127.0.0.1:9",
        ALL_PROXY="http://127.0.0.1:9",
        NO_COLOR="1",
    )
    fixtures = {
        "oar-default": "",
        "oar-hidden": "user-invocable: false\n",
        "oar-invocable": "user-invocable: true\n",
        "oar-manual": "disable-model-invocation: true\n",
    }
    for name, flags in fixtures.items():
        folder = agent / "skills" / name
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Invocation control\n{flags}---\nPRIVATE BODY\n"
        )
    source = """
const sdk = await import(process.argv[1]);
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
sdk.initTheme(settingsManager.getTheme());
const services = await sdk.createAgentSessionServices({ cwd, agentDir, settingsManager });
const { session } = await sdk.createAgentSessionFromServices({ services, sessionManager: sdk.SessionManager.inMemory(cwd) });
try { process.stdout.write(JSON.stringify(session.resourceLoader.getSkills().skills.map(s => ({ name: s.name, fields: Object.keys(s).sort(), disableModelInvocation: s.disableModelInvocation })))); }
finally { session.dispose(); }
"""
    native = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            source,
            (package / "dist/index.js").as_uri(),
        ],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if native.returncode:
        raise RuntimeError(native.stderr[:1000])
    skills = json.loads(native.stdout)
    results = []
    for enabled in (True, False):
        (agent / "settings.json").write_text(
            json.dumps({"enableSkillCommands": enabled})
        )
        with (root / "stderr").open("w") as stderr:
            child = subprocess.Popen(
                ["node", str(package / "dist/bundle/rpc-entry.js")],
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
            )
            try:
                child.stdin.write(b'{"id":"catalog","type":"get_commands"}\n')
                child.stdin.flush()
                selector = selectors.DefaultSelector()
                selector.register(child.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 30
                buffer = b""
                response = None
                while response is None and time.monotonic() < deadline:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        break
                    data = os.read(child.stdout.fileno(), 65536)
                    if not data:
                        break
                    buffer += data
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line:
                            continue
                        value = json.loads(line)
                        if value.get("id") == "catalog":
                            response = value
                            break
                selector.close()
                assert (
                    response and response["success"]
                ), "Missing native command catalog"
                commands = [
                    c for c in response["data"]["commands"] if c["source"] == "skill"
                ]
                results.append(
                    {
                        "enableSkillCommands": enabled,
                        "commands": [
                            {
                                "name": c["name"],
                                "source": c["source"],
                                "fields": sorted(c),
                            }
                            for c in commands
                        ],
                    }
                )
            finally:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
    assert {s["name"] for s in skills} == set(fixtures)
    for r in results:
        assert {c["name"] for c in r["commands"]} == {"skill:" + n for n in fixtures}
    Path(sys.argv[1]).write_text(
        json.dumps(
            {"version": version, "fixtures": fixtures, "sdk": skills, "rpc": results},
            indent=2,
        )
        + "\n"
    )
