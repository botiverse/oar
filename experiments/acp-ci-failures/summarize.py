"""Select evidence from downloaded job logs and unpacked native trace artifacts.

Usage: python3 summarize.py INPUT_DIRECTORY OUTPUT.json
INPUT_DIRECTORY contains manifest.json (the committed manifest's layout).
No network, native execution or model calls. Raw files remain private/local.
"""
import hashlib
import json
from pathlib import Path
import re
import sys


def jsonl(file):
    return [json.loads(line) for line in file.read_text().splitlines() if line]


def turns(file):
    active, rows = {}, []
    for entry in jsonl(file):
        record = entry.get("record", {})
        if record.get("agentPath"):
            continue
        body = record.get("body", {})
        session = record.get("sessionId")
        at = record.get("receivedAt", entry["at"])
        if record.get("kind") == "request" and body.get("kind") == "prompt":
            row = {"turn": len(rows) + 1, "prompt": body.get("input"),
                   "accepted": False, "firstToolMs": None, "endMs": None,
                   "outcome": None, "tools": []}
            rows.append(row)
            active[session] = (at, row)
        elif session in active:
            started, row = active[session]
            if record.get("kind") == "response" and body.get("kind") == "accepted":
                row["accepted"] = True
                active[session] = (at, row)
            for event in body.get("events", []):
                if event["kind"] == "tool_call_started":
                    if row["firstToolMs"] is None:
                        row["firstToolMs"] = at - started
                    row["tools"].append(event["tool"])
                if event["kind"] == "turn_ended":
                    row["endMs"] = at - started
                    row["outcome"] = event["outcome"]["kind"]
    return rows


def summarize(root):
    manifest = json.loads((root / "manifest.json").read_text())
    selected = []
    for cell in manifest["jobs"]:
        log = root / f'{cell["job"]}.log'
        raw = log.read_bytes()
        if hashlib.sha256(raw).hexdigest() != cell["logSha256"]:
            raise ValueError(f'Job {cell["job"]}: log hash mismatch')
        text = re.sub(r"\x1b?\[[\d;]*m", "", raw.decode())
        cases = [line.split(" FAIL ", 1)[1].strip() for line in text.splitlines() if " FAIL " in line]
        cell = {**cell, "failedCases": cases}
        trace = root / cell["directory"]
        if cell["runtime"] == "grok":
            cell["initialize15000msPresent"] = "initialize timed out after 15000ms" in text
            cell["startupControls"] = [
                {key: value for key, value in item.items() if key != "stderr"}
                | {"stderrBytes": len(item.get("stderr", "").encode())}
                for item in jsonl(trace / "grok-acp-startup.jsonl") if "outcome" in item
            ]
        else:
            cell["caseTimeoutMs"] = sorted(set(int(value) for value in re.findall(r"Test timed out in (\d+)ms", text)))
            cell["turns"] = turns(trace / "vendor-opencode-aimock" / "trace.jsonl")
        selected.append(cell)
    return {"window": manifest["window"], "jobs": selected}


if __name__ == "__main__":
    source, destination = map(Path, sys.argv[1:])
    destination.write_text(json.dumps(summarize(source), indent=2) + "\n")
