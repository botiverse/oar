"""Select catalog names and event times from one downloaded agy-acp CI artifact.

Usage: python3 experiments/antigravity-mcp-readiness/select-ci.py ARTIFACT_DIR
Only run on the synthetic MCP vendor fixture. This is an allowlisted evidence
selector, not a sanitizer for arbitrary account logs. No raw payload is printed.
"""

import hashlib
import json
import pathlib
import re
import sys

PROMPT = "please call echo over the user's own"
MCP = {"mcp_echo_echo", "call_mcp_tool", "list_resources", "read_resource"}


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def declarations(value):
    if isinstance(value, list):
        return [name for entry in value for name in declarations(entry)]
    if not isinstance(value, dict):
        return []
    names = []
    for key, entry in value.items():
        if key in ("functionDeclarations", "function_declarations"):
            names.extend(item["name"] for item in entry)
        else:
            names.extend(declarations(entry))
    return names


root = pathlib.Path(sys.argv[1])
providers = []
for path in sorted((root / "acp-provider").glob("*.jsonl")):
    requests = [row for row in rows(path) if row.get("kind") == "request"]
    if any(PROMPT in json.dumps(row.get("body")) for row in requests):
        providers.append((path, requests))
assert len(providers) == 1, "Expected exactly one name-clash provider capture"
source, requests = providers[0]
selected = []
for request in requests:
    body = request["body"]
    text = json.dumps(body)
    names = declarations(body)
    selected.append({
        "at": request["at"], "requestId": request["requestId"],
        "toolCount": len(names), "mcpTools": sorted(MCP.intersection(names)),
        "unknownTools": sorted(set(re.findall(r'unknown tool: [\\"]*(mcp_echo_echo|call_mcp_tool)', text))),
        "echoMarkers": sorted(set(re.findall(r"echo:(clash-own|clash-user) via=stdio", text))),
    })

trace_path = root / "vendor-antigravity-aimock" / "trace.jsonl"
trace = rows(trace_path)
sessions = {row["record"]["sessionId"] for row in trace if PROMPT in json.dumps(row)}
assert len(sessions) == 1, "Expected exactly one name-clash session"
session = next(iter(sessions))
records = []
for row in trace:
    record = row.get("record", {})
    if record.get("sessionId") != session:
        continue
    body = record["body"]
    events = []
    for event in body.get("events", []):
        kind = event.get("kind", event.get("type"))
        if kind in {"turn_ended", "text", "tool_call_started", "tool_call_ended"}:
            events.append({key: event[key] for key in ("kind", "type", "outcome") if key in event})
    records.append({
        "at": row["at"], "kind": record["kind"],
        "bodyKind": body.get("kind", body.get("type")), "events": events,
    })

captures = []
for manifest_path in sorted((root / "agy-mcp-failure").glob("*/manifest.json")):
    manifest = json.loads(manifest_path.read_text())
    assert manifest["case"] == "antigravity MCP name clash"
    servers = {}
    for name in ("session-echo", "user-echo", "userecho"):
        servers[name] = [{key: event[key] for key in ("at", "event", "method", "code") if key in event}
                         for event in rows(manifest_path.parent / (name + ".jsonl"))]
    native = []
    for path in sorted(manifest_path.parent.glob("native-*.log")):
        for line in path.read_text().splitlines():
            match = re.search(r"^I\d+ ([\d:.]+).*\] (Language server version: [\d.]+|Preloading \d+ MCP servers of the session|ACP Request received: session/(?:new|prompt))$", line)
            if match:
                native.append({"timeUtc": match[1], "message": match[2]})
    captures.append({"manifest": manifest, "servers": servers, "native": native})

print(json.dumps({
    "providerSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "traceSha256": hashlib.sha256(trace_path.read_bytes()).hexdigest(),
    "requests": selected, "records": records, "failureCaptures": captures,
}, indent=2))
