#!/usr/bin/env python3
"""Select request timings and matching native prompt/tool times, excluding payloads."""
import base64
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
output = Path(sys.argv[2])


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


trace = root / "vendor-opencode-aimock" / "trace.jsonl"
records = rows(trace)
prompts = [row for row in records if row.get("record", {}).get("body", {}).get("kind") == "prompt"]
selections = []
paths = sorted((root / "acp-provider").glob("*.jsonl"), key=lambda path: rows(path)[0]["at"])
for ordinal, path in enumerate(paths):
    events = rows(path)
    selected = {"fixture": ordinal, "sha256": digest(path), "bytes": path.stat().st_size, "requests": []}
    for request in [event for event in events if event["kind"] == "request"]:
        body = request.get("body") or {}
        number = request["requestId"]
        own = [event for event in events if event.get("requestId") == number]
        chunks = [event for event in own if event["kind"] == "response_chunk"]
        response = next((event for event in own if event["kind"] == "response"), None)
        ended = next((event for event in own if event["kind"] == "response_end"), None)
        closed = next((event for event in own if event["kind"] == "response_closed"), None)
        is_title = "You are a title generator" in str(body.get("system", ""))
        texts = []
        for message in body.get("messages", []):
            if message.get("role") != "user":
                continue
            content = message.get("content", [])
            texts.extend([content] if isinstance(content, str) else [part.get("text", "") for part in content if isinstance(part, dict)])
        candidates = [row for row in prompts if row["at"] <= request["at"] and row["record"]["body"]["input"] in texts]
        prompt = max(candidates, key=lambda row: row["at"]) if candidates else None
        calls = []
        payload = b"".join(base64.b64decode(chunk["base64"]) for chunk in chunks)
        for line in payload.decode("utf8", "replace").splitlines():
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            block = event.get("content_block", {})
            if block.get("type") == "tool_use":
                calls.append(block)
        native = []
        if prompt:
            for call in calls:
                matching = [row for row in records if row["at"] >= request["at"] and row.get("record", {}).get("sessionId") == prompt["record"]["sessionId"] and any(event.get("callId") == call.get("id") for event in row.get("record", {}).get("body", {}).get("events", []))]
                start = next((row["at"] for row in matching if any(event["kind"] == "tool_call_started" for event in row["record"]["body"]["events"])), None)
                end = next((row["at"] for row in matching if any(event["kind"] == "tool_call_ended" for event in row["record"]["body"]["events"])), None)
                native.append({"tool": call.get("name"), "startedAt": start, "endedAt": end})
        selected["requests"].append({
            "request": number, "at": request["at"], "role": "title" if is_title else "agent",
            "toolsOffered": len(body.get("tools", [])), "promptAt": prompt["at"] if prompt else None,
            "promptToRequestMs": request["at"] - prompt["at"] if prompt else None,
            "status": response["status"] if response else None,
            "responseEndAt": ended["at"] if ended else None,
            "requestToResponseEndMs": ended["at"] - request["at"] if ended else None,
            "complete": closed["complete"] if closed else None,
            "nativeTools": native,
        })
    selected["truncations"] = sum(event["kind"] in ("entry_truncated", "file_truncated") for event in events)
    selections.append(selected)
output.write_text(json.dumps({"traceSha256": digest(trace), "fixtures": selections}, indent=2) + "\n")
