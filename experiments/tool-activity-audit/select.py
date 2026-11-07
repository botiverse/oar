"""Select tool facts and relative timings from probe JSON; never publish raw logs."""
import hashlib
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)
files = len(sys.argv) > 3 and sys.argv[3] == "files"


def unique(values):
    result = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


for filename in sorted(source.glob("*.json")):
    data = json.loads(filename.read_text())
    if "runtimeId" not in data:
        continue
    runtime = data["runtimeId"]
    records = data["records"]
    starts = [event for record in records for event in record.get("body", {}).get("events", [])
              if event["kind"] == "tool_call_started"]
    selected = []
    for start in starts:
        call_id = start["callId"]
        if files:
            if start["tool"] in {"ToolSearch", "tool_search"}:
                continue
        elif start["tool"] in {"Read", "read", "read_file", "ToolSearch", "tool_search"} or call_id.endswith(("audit_read", "audit_search")):
            continue
        events, inputs, kinds, locations, identities = [], [], [], [], []
        for record in records:
            body = record.get("body", {})
            for event in body.get("events", []):
                if event.get("callId") == call_id and event["kind"] in {"tool_call_started", "tool_call_input", "tool_call_ended"}:
                    events.append({key: value for key, value in event.items() if key in {"kind", "tool", "server", "toolName", "input", "result", "exitCode"} or (files and key == "content")})
            native = body.get("native", {})
            update = native.get("update", {})
            if update.get("toolCallId") == call_id:
                if "rawInput" in update:
                    inputs.append(update["rawInput"])
                if "kind" in update:
                    kinds.append(update["kind"])
                locations += update.get("locations", [])
                for content in update.get("content", []):
                    if content.get("type") == "diff":
                        locations.append({"path": content.get("path"), "source": "content.diff"})
                meta = update.get("_meta", {}).get("x.ai/tool")
                if meta:
                    identities.append(meta)
                output = update.get("rawOutput", {})
                if isinstance(output, dict):
                    if "server_name" in output:
                        identities.append({key: output[key] for key in ["type", "tool_name", "server_name"] if key in output})
                    if "toolCalls" in output.get("metadata", {}):
                        identities.append({"toolCalls": output["metadata"]["toolCalls"]})
            item = native.get("item", {})
            if item.get("id") == call_id:
                kinds.append(item["type"])
                for key in ["changes", "arguments", "commandActions"]:
                    if key in item:
                        identities.append({key: item[key]})
            message = native.get("message", {})
            for block in message.get("content", []) if isinstance(message, dict) else []:
                if isinstance(block, dict) and block.get("id") == call_id and "input" in block:
                    inputs.append(block["input"])
            if native.get("toolCallId") == call_id and "args" in native:
                inputs.append(native["args"])
            event_data = native.get("data", {})
            if event_data.get("callId") == call_id and "arguments" in event_data:
                inputs.append(event_data["arguments"])
        selected.append({"tool": start["tool"], "events": events, "nativeInputs": unique(inputs),
                         "nativeKinds": unique(kinds), "nativeLocations": unique(locations), "nativeDetails": unique(identities)})
    origin = next(mark["at"] for mark in data["marks"] if mark["kind"] == "open_start")
    timing = {"openReturned": next(mark["at"] - origin for mark in data["marks"] if mark["kind"] == "open_returned"),
              "toolsListReturned": next((entry["at"] - origin for entry in data["mcp"] if entry["kind"] == "tools_list_returned"), None),
              "firstPrimaryModelRequest": next((mark["at"] - origin for mark in data["marks"] if mark["kind"] == "provider_request" and mark["value"]["primary"]), None)}
    readiness = []
    for record in records:
        body = record.get("body", {})
        native = body.get("native", {})
        if "mcp_servers" in native:
            readiness.append({"type": body["type"], "servers": native["mcp_servers"]})
        elif body.get("type", "").startswith(("mcpServer/startupStatus", "_x.ai/mcp")):
            readiness.append({"type": body["type"], "native": {key: value for key, value in native.items() if key != "sessionId" and key != "threadId"}})
    result = {"runtime": runtime, "version": data["installation"].get("version"), "mode": data["mode"],
              "sourceSha256": hashlib.sha256(filename.read_bytes()).hexdigest(),
              "failure": data.get("failure"), "fileAfterEdit": next((mark["value"] for mark in data["marks"] if mark["kind"] == "file_after_edit"), None),
              "mcpCalls": [entry for entry in data["mcp"] if entry["kind"] == "tool_called"],
              "timingMsFromOpen": timing, "readiness": unique(readiness), "tools": selected}
    if files:
        result["modelToolResults"] = unique([
            {key: message[key] for key in ["tool_call_id", "content"] if key in message}
            for request in data.get("normalized", []) for message in request.get("messages", [])
            if message.get("role") == "tool"
        ])
        if result["failure"]:
            result["failure"] = result["failure"].split("\n")[0]
    text = json.dumps(result, indent=2, ensure_ascii=False)
    for value, replacement in [(data.get("cwd"), "<project>"), (data["root"], "<probe>")]:
        if value:
            text = text.replace(value, replacement)
    # Runtime process details are useful locally, not public evidence.
    (destination / filename.name).write_text(text + "\n")
