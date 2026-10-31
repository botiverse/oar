#!/usr/bin/env python3
"""Rebuild selected ACP observations, configuration controls and resources.

Inputs are downloaded artifacts named by the manifest. Verify each input's
SHA256 before selecting fields. Exclude raw transcripts, paths, native ids,
process ids, command lines and environment values. This selects evidence;
it does not decide admission or turn missing observations into passes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import runpy

directory = runpy.run_path(str(Path(__file__).with_name("select-directory-evidence.py")))
pick, record, items = (directory[name] for name in ("pick", "record", "items"))
OBSERVATIONS = ["cwdAndMessageIsolation", "mcpIsolation", "childAttribution",
                "loadedResume", "scopedCleanup", "closeResumeRace", "exitWithActiveSessions"]
WINDOW_FIELDS = ["elapsedMs", "cpuPercentOneCore", "cpuIsLowerBound",
                 "exitedDuringWindow", "rssBytes", "processes"]


def observations(evidence):
    result = pick(evidence, ["id", "at", "platform"])
    result["reportedVersion"] = record(evidence.get("installation")).get("version")
    result["agentInfo"] = pick(record(evidence.get("initialize")).get("agentInfo"), ["name", "version"])
    result["observations"] = {}
    for name in OBSERVATIONS:
        row = record(evidence.get(name))
        result["observations"][name] = {"observed": row.get("observed"), "errorRecorded": "error" in row}

    def value(name):
        return record(record(evidence.get(name)).get("value"))

    cwd = value("cwdAndMessageIsolation")
    result["cwdAndMessages"] = {
        "stopReasons": [record(response).get("stopReason") for response in items(cwd.get("responses"))],
        "observedDirectoryCounts": [len(items(record(row).get("observed"))) for row in items(cwd.get("directories"))],
    }
    result["mcp"] = pick(value("mcpIsolation"), ["sameServerNameScopedToSession"])
    child = value("childAttribution")
    result["child"] = pick(child, ["childRequests", "peerReceivedChildReply"])
    roots = items(child.get("rootIds"))
    links = []
    for event in items(child.get("events")):
        params = record(record(event).get("params"))
        link = record(record(record(params.get("update")).get("_meta")).get("opencode/child-session"))
        if not link:
            continue
        links.append({"parentRootIndex": roots.index(link["parentID"]) if link.get("parentID") in roots else None,
                      "frameRootIndex": roots.index(params["sessionId"]) if params.get("sessionId") in roots else None,
                      "depth": link.get("depth"), "childIdPresent": isinstance(link.get("id"), str)})
    result["child"]["explicitLinks"] = links
    resumed = value("loadedResume")
    result["loadedResume"] = pick(resumed, ["method", "providerModels", "retainedHistory"])
    result["loadedResume"]["stopReason"] = record(resumed.get("response")).get("stopReason")
    cleanup = value("scopedCleanup")
    result["cleanup"] = pick(cleanup, ["peerEndedBeforeRelease"])
    result["cleanup"]["targetStopReason"] = record(record(cleanup.get("targetEnd")).get("value")).get("stopReason")
    for name in ("markers", "afterCancel", "afterNativeClose", "afterHostCleanup"):
        result["cleanup"][name + "Counts"] = [len(entries) for entries in items(cleanup.get(name))]
    for name in ("closed", "peerClosed"):
        row = record(cleanup.get(name))
        result["cleanup"][name] = {"replyRecorded": "value" in row, "errorRecorded": "error" in row}
    raced = value("closeResumeRace")
    result["closeResumeRace"] = {
        "statuses": [record(row).get("status") for row in items(raced.get("results"))],
        "stopReason": record(raced.get("response")).get("stopReason"),
    }
    exited = value("exitWithActiveSessions")
    result["exitWithActiveSessions"] = pick(exited, ["endedBeforeExit", "exit"])
    result["exitWithActiveSessions"]["ends"] = [
        {"errorRecorded": "error" in record(row), "valueRecorded": "value" in record(row)}
        for row in items(exited.get("ends"))]
    return result


def resources(evidence):
    selected = []
    for cohort in items(evidence):
        cohort = record(cohort)
        row = pick(cohort, ["mode", "count", "at", "platform", "outcome"])
        row["reportedVersion"] = record(cohort.get("installation")).get("version")
        row["errorRecorded"] = "error" in cohort
        row["cleanupErrorRecorded"] = "cleanupError" in cohort
        row["opened"] = pick(cohort.get("opened"), WINDOW_FIELDS)
        row["windows"] = [pick(window, WINDOW_FIELDS) for window in items(cohort.get("afterTurn"))]
        selected.append(row)
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--input-root", type=Path, required=True)
    args = parser.parse_args()
    selected = []
    for entry in json.loads(args.manifest.read_text()):
        evidence = {}
        for kind, source in entry["inputs"].items():
            raw = (args.input_root / source["path"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != source["sha256"]:
                raise ValueError(f"input SHA256 mismatch: {source['path']}")
            evidence[kind] = json.loads(raw)
        row = pick(entry, ["runtime", "requestedVersion", "platform", "source", "steps"])
        row["native"] = observations(evidence["native"])
        row["resources"] = resources(evidence["resources"])
        for name in ("sameDirectory", "configurationFreshness"):
            row[name] = directory["select"](evidence[name], entry["source"], entry["requestedVersion"])
            row[name]["failureReasons"] = evidence[name].get("failureReasons")
        selected.append(row)
    args.output.write_text(json.dumps(selected, indent=2) + "\n")


if __name__ == "__main__":
    main()
