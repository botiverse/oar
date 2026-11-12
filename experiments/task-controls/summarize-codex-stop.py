"""Select timing evidence from a task-stop artifact without copying paths or IDs.

Usage: python3 experiments/task-controls/summarize-codex-stop.py ARTIFACT.json
Reads only the named artifact. Does not start Codex or access a provider.
"""

import json
import sys
from pathlib import Path


def summarize(data):
    records = data["records"]
    root = records[0]["sessionId"]
    frames = [record for record in records if record["kind"] == "frame"]
    names = {root: "/root"}
    versions = set()
    for frame in frames:
        native = frame["body"].get("native", {})
        item = native.get("item", {})
        if item.get("type") == "subAgentActivity":
            names[item["agentThreadId"]] = item["agentPath"]
        version = native.get("thread", {}).get("cliVersion")
        if version:
            versions.add(version)

    turns = {name: [] for name in names.values()}
    activities = []
    turn_ids = {}
    for frame in frames:
        body = frame["body"]
        native = body.get("native", {})
        name = names.get(frame["sessionId"])
        if name is None:
            continue
        if body["type"] in ("turn/started", "turn/completed"):
            turn = native["turn"]
            ordinal = turn_ids.setdefault(turn["id"], len(turns[name]))
            if body["type"] == "turn/started":
                turns[name].append({"startSeq": frame["seq"]})
            else:
                turns[name][ordinal].update(endSeq=frame["seq"], status=turn["status"])
        item = native.get("item", {})
        if body["type"] == "item/completed" and item.get("type") == "subAgentActivity":
            activities.append({"seq": frame["seq"], "kind": item["kind"], "agent": item["agentPath"], "isFollowup": item["id"] == "followup_a"})

    requests = []
    for ordinal, request in enumerate(data["requests"], start=1):
        body = request["body"]
        body = json.loads(body) if isinstance(body, str) else body
        items = body["input"]
        if not any(item.get("role") == "user" and any(part.get("text") == "PARENT_FOLLOWUP" for part in item.get("content", []) if isinstance(part, dict)) for item in items):
            continue
        requests.append({
            "request": ordinal,
            "peerMessage": any(item.get("type") == "agent_message" and item.get("author") == "/root/b" and item.get("recipient") == "/root" for item in items),
            "followupResult": any(item.get("type") == "function_call_output" and item.get("call_id") == "followup_a" for item in items),
        })

    return {
        "cliVersions": sorted(versions),
        "rootCalls": data["rootCalls"],
        "targetCalls": data["targetCalls"],
        "followupReplies": data["followupReplies"],
        "followupRequests": requests,
        "nativeTurns": turns,
        "taskActivities": activities,
    }


if __name__ == "__main__":
    print(json.dumps(summarize(json.loads(Path(sys.argv[1]).read_text())), indent=2))
