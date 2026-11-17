"""Select public evidence from probe output; usage: select.py raw-prefix output.json."""
import hashlib
import json
import re
import sys
from pathlib import Path

prefix, destination = sys.argv[1:]
result = {"selection": "Control results, state transitions, relevant native frames, and process groups. Repeated polling is compressed to changes. Provider bodies, command arguments, local paths and absolute timestamps are omitted.", "cases": []}
for mode in ["complete", "idle-abort", "active-abort", "foreground-abort", "dispose"]:
    source = Path(prefix + mode + ".json")
    data = json.loads(source.read_text())
    ticks = []
    previous = {}
    for tick in data["ticks"]:
        kind, value = tick["kind"], tick.get("value")
        if kind == "command":
            continue
        if kind == "record":
            body = value.get("body", {})
            if value["kind"] != "frame":
                continue
            native = body.get("native", {})
            update = native.get("update", {})
            if body["type"] not in ["session/prompt", "tool_call", "tool_call_update", "agent_message_chunk"]:
                continue
            events = []
            for event in body.get("events", []):
                selected = {key: item for key, item in event.items() if key not in ["input", "content"]}
                events.append(selected)
            value = {"seq": value["seq"], "frameType": body["type"], "native": {key: item for key, item in {"stopReason": native.get("stopReason"), "sessionUpdate": update.get("sessionUpdate"), "status": update.get("status"), "toolCallId": update.get("toolCallId"), "exitCode": update.get("rawOutput", {}).get("exit_code")}.items() if item is not None}, "events": events}
        elif kind in ["abort", "abort-after-end", "later-submission"]:
            value = {"kind": value["kind"], "code": value.get("code"), "requestSeq": value["request"]["seq"], "response": value["response"]["body"]}
        elif kind.startswith("waiting-"):
            # Preserve changes in process identities and session status, not identical polling.
            if value == previous.get(kind):
                continue
            previous[kind] = value
        ticks.append({"atMs": tick["atMs"], "kind": kind, "value": value})
    result["cases"].append({"mode": mode, "version": data["version"], "platform": data["platform"], "base": data["base"], "error": data.get("error"), "rawSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "providerRequests": [{"atMs": item["atMs"], "call": item["call"]} for item in data["provider"]], "ticks": ticks})
def omit_absolute_times(value):
    if isinstance(value, dict):
        return {key: omit_absolute_times(item) for key, item in value.items() if key not in ["receivedAt", "lastEventAt"]}
    if isinstance(value, list):
        return [omit_absolute_times(item) for item in value]
    return value

encoded = json.dumps(omit_absolute_times(result), indent=2, ensure_ascii=False)
assert re.search(r"/tmp/|/home/|api.?key|bearer", encoded, re.I) is None
Path(destination).write_text(encoded + "\n")
