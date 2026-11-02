"""Select native control facts, omitting conversation text, account data and local paths.

Usage: python experiments/manual-compaction/select-followup-evidence.py INPUT_DIR OUTPUT
INPUT_DIR holds the manual-compaction-*.json outputs named in the report.
Identifiers become stable per-file aliases, preserving equality and frame order.
"""
import argparse
import json
from pathlib import Path


def pick(value, keys):
    return {key: value[key] for key in keys if key in value}


def aliases(value):
    identities = {}
    fields = {"id", "sessionId", "session_id", "agent_id", "run_id", "spanId",
              "messageId", "command_uuid", "requestId", "request_id", "uuid", "compactionId"}

    def visit(item):
        if isinstance(item, list):
            return [visit(child) for child in item]
        if not isinstance(item, dict):
            return item
        result = {}
        for key, child in item.items():
            if key in fields and isinstance(child, str):
                child = identities.setdefault(child, f"native-id-{len(identities) + 1}")
                result[key] = child
            else:
                result[key] = visit(child)
        return result
    return visit(value)


def acp(case):
    result = pick(case, ["backend", "version", "scenario", "answer"])
    result["markers"] = []
    for marker in case["markers"]:
        result["markers"].append(pick(marker, ["method", "sessionId", "update"]))
    return result


def qoder(case):
    result = pick(case, ["version", "scenario", "commandLoaded", "outcome"])
    result["abort"] = None if case["abort"] is None else pick(case["abort"], ["kind"])
    result["frames"] = []
    for frame in case["frames"]:
        native = pick(frame["native"], ["type", "subtype", "status", "state", "command_uuid",
                      "session_id", "uuid", "is_error", "compact_metadata"])
        events = [event for event in frame["events"] if event["kind"] in
                  {"compaction_started", "compaction_ended", "turn_ended"}]
        result["frames"].append({"type": frame["type"], "native": native, "events": events})
    return result


def cursor_frame(frame):
    body = frame.get("body", frame)
    native = pick(body["native"], ["type", "agent_id", "run_id", "id", "status", "fallback"])
    return {**pick(frame, ["sessionId", "agentPath", "spanId"]),
            "type": body["type"], "native": native, "events": body["events"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    def read(name):
        return json.loads((args.input_dir / f"manual-compaction-{name}.json").read_text())

    cursor = read("cursor-control/selected")
    selected = {
        "selection": "Native control facts only; identifiers aliased, conversation and account data omitted.",
        "platform": "Linux x64",
        "grok": aliases([acp(case) for case in read("grok-lifecycle")]),
        "opencode": aliases([acp(case) for case in read("opencode-lifecycle")]),
        "opencodeCommandControl": aliases(read("opencode-v2-final")),
        "qoder": aliases([qoder(case) for case in read("qoder-lifecycle")]),
        "cursor": aliases({
            **pick(cursor, ["sdk", "empty", "cancelled", "usage"]),
            "account": "existing real account; no identifying fields retained",
            "model": "gpt-5.4-nano",
            "usageScope": "Ordinary seed turn only; summary usage unavailable, not the experiment total.",
            "completed": {"kind": cursor["completed"]["kind"],
                          "frame": cursor_frame(cursor["completed"]["frame"])},
            "cancelledFrames": [cursor_frame(frame) for frame in cursor["selected"]],
        }),
    }
    args.output.write_text(json.dumps(selected, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
