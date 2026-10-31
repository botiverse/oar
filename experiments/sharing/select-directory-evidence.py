#!/usr/bin/env python3
"""Select synthetic directory-probe observations from an explicit input manifest.

Usage: python3 experiments/sharing/select-directory-evidence.py manifest.json output.json
Each manifest row contains evidencePath, requestedVersion and source, with
optional exitCode. Paths are relative to the manifest. Source metadata is
copied as provided; review it before publishing. Raw model requests, paths,
session IDs and hook payloads are deliberately excluded from selection.
"""
import argparse
import json
from pathlib import Path

INPUTS = ["A_mcpbefore", "B_mcpafter", "A_mcpafter", "A_mcptogether",
          "B_mcptogether", "B_mcppeerclosed", "A_mcpempty",
          "A_mcpfreshbefore", "B_mcpfreshafter"]

def record(value):
    return value if isinstance(value, dict) else {}


def items(value):
    return value if isinstance(value, list) else []


def pick(row, keys):
    row = record(row)
    return {key: row[key] for key in keys if key in row}


def hook_input(event):
    event = record(event)
    args = (event.get("tool_input") or event.get("toolInput") or event.get("input")
            or record(event.get("toolCall")).get("args") or {})
    if not isinstance(args, dict):
        return None
    direct = (args.get("text") or record(args.get("tool_input")).get("text")
              or record(args.get("Arguments")).get("text"))
    if direct in INPUTS:
        return direct
    for input_text in INPUTS:
        expression = "return await tools.scope.echo(" + json.dumps(
            {"text": input_text}, separators=(",", ":")) + ");"
        if args.get("code") == expression:
            return input_text
    return None


def hooks(cohort):
    selected = []
    for hook in items(record(cohort.get("directoryConfiguration")).get("hooks")):
        hook = record(hook)
        if not isinstance(hook.get("event"), dict):
            selected.append({"revision": hook.get("revision"), "input": None, "eventMissing": True})
            continue
        input_text = hook_input(hook.get("event"))
        if input_text is not None:
            selected.append({"revision": hook.get("revision"), "input": input_text})
    return selected


def select(evidence, source, requested_version):
    row = pick(evidence, ["runtime", "at", "platform", "architecture", "settlingMs",
                         "configurationComparison", "missingEvidence",
                         "configurationFollowupComparison", "trustFollowupComparison"])
    row["source"] = source
    row["requestedVersion"] = requested_version
    cohorts = items(evidence.get("cohorts"))
    first = record(cohorts[0]) if cohorts else {}
    row["reportedVersion"] = record(first.get("installation")).get("version")
    row["cohorts"] = []
    for cohort in cohorts:
        cohort = record(cohort)
        selected = pick(cohort, ["mode", "observed", "isolated"])
        selected["errorRecorded"] = "error" in cohort
        selected["turns"] = [pick(turn, ["input", "invocation", "finalInvocation",
                                       "nativeOutputRetained", "directoryRuleMarkers", "isolated"])
                             for turn in items(cohort.get("turns"))]
        selected["hooks"] = hooks(cohort)
        config = record(cohort.get("directoryConfiguration"))
        selected.update(pick(config, ["hookScope", "trustCondition"]))
        selected["projectRuleFiles"] = sorted({revision["projectRuleFile"]
                                               for revision in items(config.get("revisions"))
                                               if isinstance(revision, dict) and isinstance(revision.get("projectRuleFile"), str)})
        release = record(cohort.get("releasedDirectory"))
        selected["releasedDirectory"] = pick(release, ["observed", "sentMcpServers", "calls",
                                                       "retainedMcpInvoked", "nativeOutputRetained",
                                                       "finalSurvivorInvocation"])
        for field in ["releasedA", "releasedB"]:
            selected["releasedDirectory"][field] = pick(release.get(field, {}),
                                                       ["method", "nativeClose", "closeAdvertised", "scope"])
        selected["releasedDirectory"]["afterARelease"] = pick(release.get("afterARelease", {}),
                                                              ["invocation", "isolated"])
        row["cohorts"].append(selected)
    for field in ["configurationFollowup", "trustFollowup"]:
        if field not in evidence:
            continue
        row[field] = []
        for cohort in items(evidence[field]):
            cohort = record(cohort)
            selected = pick(cohort, ["scenario", "mode", "observed", "bInvocation", "aInvocation",
                                     "aHookObserved", "bHookObserved", "bNativeOutputRetained",
                                     "aBypassHookTrust", "bBypassHookTrust", "scope"])
            if "turns" in cohort:
                selected["turns"] = [pick(turn, ["input", "invocation", "nativeOutputRetained",
                                                "hookRevisions", "directoryRuleMarkers"])
                                     for turn in items(cohort.get("turns"))]
            selected["newSessionMarkers"] = record(cohort.get("newSession")).get("directoryRuleMarkers")
            selected["hooks"] = hooks(cohort)
            selected["errorRecorded"] = "error" in cohort
            if field == "configurationFollowup":
                wait = next((wait for wait in items(cohort.get("waits"))
                             if isinstance(wait, dict) and wait.get("label") == "configuration settling before B open"), {})
                selected["beforeBOpenDelayMs"] = wait.get("limitMs")
            row[field].append(selected)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    selected = []
    for item in manifest:
        evidence = json.loads((args.manifest.parent / item["evidencePath"]).read_text())
        row = select(evidence, item["source"], item["requestedVersion"])
        if "exitCode" in item:
            row["exitCode"] = item["exitCode"]
            # Errors can include native text. This experiment is synthetic;
            # selected failure text still needs review before publication.
            row["failureReasons"] = evidence.get("failureReasons", [])
        selected.append(row)
    args.output.write_text(json.dumps(selected, indent=2) + "\n")


if __name__ == "__main__":
    main()
