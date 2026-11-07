#!/usr/bin/env python3
"""POSIX control: delay Vitest's batched updates before blocking its worker."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
NAME = "blocked native worker"


def read_rows(filename):
    if not filename.exists():
        return []
    return [json.loads(line) for line in filename.read_text().splitlines()]


def run_case(base, mode):
    directory = base / mode
    directory.mkdir()
    wait = "await new Promise(resolve => setTimeout(resolve, 500));"
    if mode == "observed-ready":
        wait = """await expect.poll(() => {
  try { return JSON.parse(readFileSync(active, "utf8")).some(entry => entry.name === name); }
  catch { return false; }
}, { timeout: 900, interval: 10 }).toBe(true);"""
    (directory / "probe.test.ts").write_text(f"""import {{ appendFileSync, readFileSync }} from "node:fs";
import {{ test, expect }} from {json.dumps((ROOT / 'node_modules/vitest/dist/index.js').as_uri())};
const name = {json.dumps(NAME)};
const active = {json.dumps(str(directory / 'active-tests.json'))};
const mark = kind => appendFileSync({json.dumps(str(directory / 'worker.jsonl'))}, JSON.stringify({{kind, at:new Date().toISOString()}})+"\\n");
mark("module_loaded");
test(name, async () => {{
  mark("case_entered");
  {wait}
  mark("worker_blocking");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}});
""")
    config = {
        "root": str(directory),
        "test": {
            "include": ["probe.test.ts"],
            "testTimeout": 1000,
            "reporters": [str(ROOT / "sea-trial/pi-rpc-progress.ts")],
        },
    }
    config_path = directory / "vitest.config.mjs"
    config_path.write_text("export default " + json.dumps(config) + ";\n")
    environment = dict(os.environ, CI="1", OAR_PI_RPC_DIAGNOSTICS=str(directory))
    # Deliberate scheduling control, not an assertion about the Windows failure.
    environment["NODE_OPTIONS"] = "--import=" + (base / "slow-timer.mjs").as_uri()
    with (directory / "output.log").open("w") as output:
        process = subprocess.Popen(
            ["node", str(ROOT / "node_modules/vitest/vitest.mjs"), "run", "--config", str(config_path)],
            cwd=ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            pass
        finally:
            # Only this probe's process group. No hung worker is left behind.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    active_path = directory / "active-tests.json"
    active = json.loads(active_path.read_text()) if active_path.exists() else []
    return {
        "mode": mode,
        "exitCode": process.returncode,
        "worker": read_rows(directory / "worker.jsonl"),
        "reporter": [
            {key: row[key] for key in ("kind", "at", "name", "state") if key in row}
            for row in read_rows(directory / "tests.jsonl")
        ],
        "activeNames": [row["name"] for row in active],
    }


def main():
    if os.name != "posix":
        raise SystemExit("This scheduling control uses POSIX process groups; run the watchdog test on Windows.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="New directory for raw local evidence and selected.json")
    arguments = parser.parse_args()
    if arguments.output:
        base = arguments.output.resolve()
        base.mkdir(parents=True)
    else:
        base = Path(tempfile.mkdtemp(prefix="oar-watchdog-readiness-"))
    (base / "slow-timer.mjs").write_text(
        "const native = globalThis.setTimeout; "
        "globalThis.setTimeout = (callback, delay, ...args) => "
        "native(callback, delay === 100 ? 750 : delay, ...args);\n"
    )
    results = [run_case(base, mode) for mode in ("fixed-wait", "observed-ready")]
    selected = {
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "vitest": json.loads((ROOT / "node_modules/vitest/package.json").read_text())["version"],
        "platform": "posix",
        "results": results,
    }
    (base / "selected.json").write_text(json.dumps(selected, indent=2) + "\n")
    print(json.dumps(selected, indent=2))
    for row in results:
        assert row["exitCode"] == -signal.SIGKILL, row
        assert [event["kind"] for event in row["worker"]] == ["module_loaded", "case_entered", "worker_blocking"], row
    assert results[0]["activeNames"] == [], results[0]
    assert not any(row["kind"] == "case_start" for row in results[0]["reporter"]), results[0]
    assert results[1]["activeNames"] == [NAME], results[1]
    started = next(row["at"] for row in results[1]["reporter"] if row["kind"] == "case_start")
    assert started <= results[1]["worker"][-1]["at"], results[1]


if __name__ == "__main__":
    main()
