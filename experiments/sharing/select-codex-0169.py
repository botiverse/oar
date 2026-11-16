"""Select only the facts cited by the 0.169.0 report from a downloaded artifact."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("artifact", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--environment", action="store_true", help="Read one child-environment evidence file instead of an artifact directory")
parser.add_argument("--resources", action="store_true", help="Read one resource evidence file, retaining every window")
args = parser.parse_args()
fingerprints = {}

if args.resources:
    raw = args.artifact.read_bytes()
    evidence = json.loads(raw)
    names = ["elapsedMs", "cpuPercentOneCore", "cpuIsLowerBound", "exitedDuringWindow", "rssBytes", "processes"]
    selected = {"rawSha256": hashlib.sha256(raw).hexdigest(), "cohorts": [
        {**{key: row[key] for key in ["mode", "count", "sampling", "at", "platform", "installation", "outcome"]},
         "error": row.get("error"),
         "opened": {key: row["opened"][key] for key in names},
         "afterTurn": [{key: window[key] for key in names} for window in row["afterTurn"]]}
        for row in evidence]}
    for row in selected["cohorts"]:
        row["installation"].pop("command", None)
    args.output.write_text(json.dumps(selected, indent=2) + "\n")
    sys.exit(0)


if args.environment:
    raw = args.artifact.read_bytes()
    evidence = json.loads(raw)

    def child(row):
        directory = row["directory"]
        normalize = str.casefold if evidence["platform"] == "win32" else str
        expected = normalize(directory["expectedCanonical"])
        return {"label": row.get("input", row.get("label")),
                "environmentMarker": row["environmentMarker"],
                "cwdMatchesSession": bool(directory["observed"]) and all(
                    normalize(value["canonical"]) == expected for value in directory["observed"])}

    selected = {"rawSha256": hashlib.sha256(raw).hexdigest(),
                **{key: evidence[key] for key in ["at", "platform", "architecture", "scope", "passed"]},
                "cohorts": [{"mode": row["mode"], "observed": row["observed"],
                             "tools": [child(turn) for turn in row["turns"] if "directory" in turn],
                             "stdioMcp": [child(value) for value in row["mcpChildren"]],
                             "hooks": [child(value) for value in row["hookChildren"]]}
                            for row in evidence["cohorts"]]}
    args.output.write_text(json.dumps(selected, indent=2) + "\n")
    sys.exit(0)


def read(name):
    matches = list(args.artifact.rglob(f"{name}/evidence.json"))
    assert len(matches) == 1, (name, matches)
    data = matches[0].read_bytes()
    fingerprints[name] = hashlib.sha256(data).hexdigest()
    return json.loads(data)


def fields(row, names):
    return {name: row[name] for name in names if name in row}


native = read("codex-sharing")
directory = read("same-directory-codex")
trust = read("codex-persisted-trust")
resources = read("codex-sharing-resources")
assert native["installation"]["version"] == "codex-cli 0.169.0"
cohorts = []
for row in trust["cohorts"]:
    cohorts.append({
        "mode": row["mode"], "observed": row["observed"],
        "turns": [{"phase": turn["phase"], "input": turn["input"],
                   "trustStatus": [hook["trustStatus"] for hook in turn["hooks"]],
                   "turnStatus": turn["response"]["status"],
                   "invocation": turn["invocation"], "hookRevisions": turn["hookRevisions"]}
                  for turn in row["turns"]],
        "hookJournal": [{"revision": hook["revision"],
                         "event": fields(hook["event"], ["hook_event_name", "tool_name", "tool_input", "tool_use_id"])}
                        for hook in row["directoryConfiguration"]["hooks"]],
        "nativeHookCompletions": [fields(hook, ["eventName", "handlerType", "status", "durationMs", "exitCode", "exitCodeSource"])
                                  for hook in row["nativeHookCompletions"]],
    })

resource_fields = ["elapsedMs", "cpuPercentOneCore", "cpuIsLowerBound", "exitedDuringWindow", "rssBytes", "processes"]
selected = {
    "version": native["installation"]["version"], "platform": native["platform"],
    "architecture": trust["architecture"], "at": native["at"], "rawSha256": fingerprints,
    "nativeGates": {key: value["observed"] for key, value in native.items()
                    if isinstance(value, dict) and "observed" in value},
    "loadedResume": fields(native["loadedResumeOverride"]["value"],
                           ["returnedModel", "requestedModel", "status", "providerModels", "adapterRefusal", "peerAfterRefusal"]),
    "unsubscribedResume": fields(native["unsubscribeAndResume"]["value"], ["returnedModel", "status", "providerModels"]),
    "directory": {"cohorts": [fields(row, ["mode", "observed", "isolated"]) for row in directory["cohorts"]],
                  **fields(directory, ["configurationComparison", "trustFollowupComparison", "failureReasons", "missingEvidence"])},
    "persistedTrust": {"comparison": trust["comparison"], "cohorts": cohorts},
    "resources": [{**fields(row, ["mode", "count", "outcome"]), "opened": fields(row["opened"], resource_fields),
                   "afterTurn": [fields(window, resource_fields) for window in row["afterTurn"]]} for row in resources],
}
args.output.write_text(json.dumps(selected, indent=2) + "\n")
