#!/usr/bin/env python3
"""Select timings and source digests from complete retained OpenCode logs.

Usage: python3 native-snapshot-timeline.py ARTIFACT_DIRECTORY OUTPUT.json
No runtime is executed. Local paths, native run IDs and message bodies are
not emitted. Truncated head/tail segments cannot establish a full timeline
and are excluded. Check the retention manifests for omissions separately.
"""
import collections
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys


def select(file):
    groups = collections.defaultdict(list)
    data = file.read_bytes()
    for line in data.decode().splitlines():
        match = re.match(r"timestamp=(\S+) level=\S+ run=(\S+) message=(\S+)", line)
        if not match:
            continue
        at = round(datetime.datetime.fromisoformat(
            match[1].replace("Z", "+00:00")).timestamp() * 1000)
        groups[match[2]].append({"at": at, "message": match[3], "line": line})
    runs = []
    for events in groups.values():
        events.sort(key=lambda row: row["at"])
        initialized = next((row for row in events
                            if row["message"] == "initialized"), None)
        tracking = next((row for row in events if row["message"] == "tracking"
                         and (initialized is None
                              or row["at"] >= initialized["at"])), None)
        if tracking is None:
            continue
        agent = next((row for row in events if row["message"] == "stream"
                      and "small=false" in row["line"]
                      and row["at"] >= tracking["at"]), None)
        loop = next((row for row in events if row["message"] == "loop"), None)
        title = next((row for row in events if row["message"] == "stream"
                      and "agent=title" in row["line"]), None)
        runs.append({
            "firstLoopAt": when(loop),
            "titleStreamAt": when(title),
            "snapshotInitializedAt": when(initialized),
            "firstTrackingAt": when(tracking),
            "firstAgentStreamAt": when(agent),
            "initializedToTrackingMs": elapsed(initialized, tracking),
            "trackingToAgentStreamMs": elapsed(tracking, agent),
            "loopToTrackingMs": elapsed(loop, tracking),
            "trackingRecords": sum(row["message"] == "tracking" for row in events),
        })
    if not runs:
        return None
    return {
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "runs": sorted(runs, key=lambda row: row["firstTrackingAt"]),
    }


def when(row):
    return None if row is None else row["at"]


def elapsed(first, last):
    return None if first is None or last is None else last["at"] - first["at"]


def main():
    root, output = map(Path, sys.argv[1:])
    selected = [row for file in root.glob("native-opencode/*/opencode.log")
                if (row := select(file)) is not None]
    selected.sort(key=lambda row: row["runs"][0]["firstTrackingAt"])
    for ordinal, row in enumerate(selected):
        row["fixture"] = ordinal
    output.write_text(json.dumps({"fixtures": selected}, indent=2) + "\n")


if __name__ == "__main__":
    main()
