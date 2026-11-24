"""Probe cold workspace catalogs on Linux. Pass a native binary and broken, slow or package."""
import argparse
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import subprocess
import tempfile
import threading
import time
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, Request, build_opener


@contextmanager
def registry():
    requested = threading.Event()
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/oar-activation-fixture"):
                requested.set()
                release.wait(15)
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":"fixture package is missing"}')

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", requested, release
        finally:
            release.set()
            server.shutdown()
            thread.join()


@contextmanager
def serve(binary, cwd, env):
    child = subprocess.Popen(
        [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
        cwd=cwd, env=env, stdout=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 20
            while selector.select(max(0, deadline - time.monotonic())):
                line = child.stdout.readline()
                if not line:
                    break
                match = re.fullmatch(r"server listening on (http://127\.0\.0\.1:\d+)/?", line.strip())
                if match:
                    yield match[1]
                    return
            raise RuntimeError("server did not publish a loopback endpoint")
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if child.poll() is not None:
                break
            os.killpg(child.pid, sig)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                continue
        child.stdout.close()


def probe(binary, mode, root, registry_url, requested, release):
    home = root / "home"
    project = root / "project A"
    launch = root / "launch"
    home.mkdir()
    launch.mkdir()
    (project / ".git").mkdir(parents=True)
    roots = [(project / ".opencode", "project-skill"), (home / ".agents", "home-skill")]
    projects = [project]
    if mode == "slow":
        other = root / "project B"
        (other / ".git").mkdir(parents=True)
        roots.append((other / ".opencode", "second-project-skill"))
        projects.append(other)
    for directory, name in roots:
        skill = directory / "skills" / name / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(f"---\nname: {name}\ndescription: fixture skill\n---\nFixture.\n")
    if mode == "package":
        (project / "opencode.json").write_text('{"plugins":["oar-activation-fixture@1.0.0"]}')
    else:
        delay = "await new Promise(resolve => setTimeout(resolve, 900));\n" if mode == "slow" else ""
        for directory in projects:
            plugins = directory / ".opencode" / "plugins"
            plugins.mkdir()
            (plugins / "broken.ts").write_text(delay + 'throw new Error("fixture");\nexport default {};\n')

    password = secrets.token_hex(24)
    env = {
        "PATH": os.environ["PATH"], "HOME": str(home), "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_STATE_HOME": str(root / "state"), "XDG_DATA_HOME": str(root / "data"),
        "OPENCODE_PASSWORD": password, "OPENCODE_DISABLE_AUTOUPDATE": "1",
        "OPENCODE_DISABLE_MODELS_FETCH": "1", "npm_config_registry": registry_url,
        "npm_config_fetch_retries": "0", "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost",
    }
    version = subprocess.check_output([binary, "--version"], env=env, text=True, timeout=15).strip()
    client = build_opener(ProxyHandler({}))
    with serve(binary, launch, env) as origin:
        def read(endpoint, scope="header", directory=project):
            url = f"{origin}/api/{endpoint}"
            headers = {"Authorization": "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()}
            if scope == "header":
                headers["x-opencode-directory"] = quote(str(directory), safe="")
            elif scope == "query":
                url += "?" + urlencode({"location[directory]": str(directory)})
            with client.open(Request(url, headers=headers), timeout=8) as response:
                value = json.load(response)
            assert Path(value["location"]["directory"]) == (launch if scope == "none" else directory)
            return value["data"]

        def snapshot(scope):
            plugins = read("plugin", scope)
            skills = read("skill", scope)
            return {
                "plugins": len(plugins), "failed": sum(p["state"]["status"] == "failed" for p in plugins),
                "skills": sorted(s["name"] for s in skills),
            }

        if mode == "slow":
            # Alternate the two requested projects while the same server activates each location.
            started = time.monotonic()
            for directory, scope in [(project, "header"), (projects[1], "query"), (launch, "none")]:
                for endpoint in ("provider", "plugin", "skill"):
                    read(endpoint, scope, directory)
            samples = []
            for target in (0.3, 1.3, 3):
                time.sleep(max(0, started + target - time.monotonic()))
                for directory, scope in [(project, "query"), (projects[1], "header"), (launch, "none")]:
                    for endpoint in ("plugin", "skill"):
                        before = time.monotonic()
                        rows = read(endpoint, scope, directory)
                        sample = {"targetSeconds": target, "directory": directory.name, "scope": scope,
                                  "endpoint": endpoint, "atMs": round((before - started) * 1000),
                                  "durationMs": round((time.monotonic() - before) * 1000), "count": len(rows)}
                        if endpoint == "skill":
                            sample["names"] = sorted(row["name"] for row in rows)
                        samples.append(sample)
            return {"version": version, "mode": mode, "pluginDelayMs": 900, "samples": samples}

        result = {"version": version, "mode": mode, "providers": len(read("provider")), "cold": snapshot("header")}

        def wait_for(predicate):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                sample = snapshot("query")
                if predicate(sample):
                    return sample
                time.sleep(0.025)
            raise RuntimeError("fixture did not reach expected native state")

        if mode == "package":
            result["pending"] = wait_for(lambda s: requested.is_set() and s["plugins"] > 0)
            assert result["pending"]["failed"] == 0
            release.set()
        result["settled"] = wait_for(lambda s: s["failed"] == 1 and "project-skill" in s["skills"])
        assert "home-skill" in result["settled"]["skills"]
        result["unscoped"] = snapshot("none")
        assert "project-skill" not in result["unscoped"]["skills"]
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("mode", choices=["broken", "slow", "package"])
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="oar-activation-") as directory, registry() as fake:
        print(json.dumps(probe(args.binary.resolve(), args.mode, Path(directory), *fake), indent=2))
