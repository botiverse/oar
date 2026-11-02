"""Select portable evidence from probe.ts output, without host paths or credentials."""

import collections
import json
import pathlib
import re
import sys


def select_step(step):
    frames = [r["body"] for r in step["records"] if r["kind"] == "frame"]
    events = [e for frame in frames for e in frame["events"]]
    text = "".join(e["text"] for e in events if e["kind"] == "text_delta")
    native = [f["native"] for f in frames]
    stream = [f["event"] for f in native if f.get("type") == "stream_event"]
    counts = collections.Counter(f["type"] for f in native)
    stream_counts = collections.Counter(e["type"] for e in stream)
    requests = []
    for request in step["requests"]:
        body = request["body"]
        messages = body["messages"]
        last = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        encoded_last = json.dumps(last)
        encoded_all = json.dumps(messages)
        system = json.dumps([m for m in messages if m["role"] == "system"])
        summary = "Then, produce the <state_snapshot> XML." in encoded_last or "You are a context summarization assistant." in system
        requests.append({
            "model": body.get("model"),
            "summary_request": summary,
            "last_user_probe_markers": sorted(set(re.findall(r"OAR_(?:INITIAL|HIGH_USAGE|AFTER|SAME_STATUS|SHADOW_COMPRESS_MODEL)", encoded_last))),
            "history_summary_markers": sorted(set(re.findall(r"OAR_NATIVE_SUMMARY_\d+", encoded_all))),
        })
    assistants = []
    for frame in native:
        if frame.get("type") == "assistant":
            message = frame["message"]
            assistants.append({"role": message["role"], "model": message.get("model"),
                               "usage": message.get("usage"),
                               "content_types": [b["type"] for b in message["content"]]})
    results = [{key: frame[key] for key in ("type", "subtype", "is_error", "num_turns", "duration_api_ms") if key in frame}
               for frame in native if frame.get("type") == "result"]
    return {"input": step["input"], "outcome": step["outcome"], "summaries_so_far": step["summaries"],
            "native_frame_counts": dict(sorted(counts.items())), "native_stream_event_counts": dict(sorted(stream_counts.items())),
            "assistant_messages": assistants, "results": results,
            "text_length": len(text), "text_prefix": text[:100],
            "compaction_events": [e for e in events if e["kind"].startswith("compaction_")],
            "provider_requests": requests}


root = pathlib.Path(sys.argv[1])
selected = {"observed_at": "2026-11-02", "platform": "linux-x64", "cases": []}
for mode in ("manual", "automatic", "shadowed"):
    raw = json.loads((root / f"{mode}.json").read_text())
    selected["cases"].append({"mode": mode, "version": raw["installation"]["version"],
                              "summary_requests": raw["summaries"], "steps": [select_step(s) for s in raw["steps"]]})
print(json.dumps(selected, indent=2) + "\n", end="")
