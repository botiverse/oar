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

def pick(row, keys):
    return {key: row[key] for key in keys if key in row}


def hook_input(event):
    args = (event.get("tool_input") or event.get("toolInput") or event.get("input")
            or event.get("toolCall", {}).get("args") or {})
    if not isinstance(args, dict):
        return None
    direct = (args.get("text") or args.get("tool_input", {}).get("text")
              or args.get("Arguments", {}).get("text"))
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
    for hook in cohort.get("directoryConfiguration", {}).get("hooks", []):
        input_text = hook_input(hook["event"])
        if input_text is not None:
            selected.append({"revision": hook["revision"], "input": input_text})
    return selected


def select(evidence, source, requested_version):
    row = pick(evidence, ["runtime", "at", "platform", "architecture", "settlingMs",
                         "configurationComparison", "missingEvidence",
                         "configurationFollowupComparison", "trustFollowupComparison"])
    row["source"] = source
    row["requestedVersion"] = requested_version
    row["reportedVersion"] = evidence["cohorts"][0]["installation"].get("version")
    row["cohorts"] = []
    for cohort in evidence["cohorts"]:
        selected = pick(cohort, ["mode", "observed", "isolated"])
        selected["errorRecorded"] = "error" in cohort
        selected["turns"] = [pick(turn, ["input", "invocation", "finalInvocation",
                                       "nativeOutputRetained", "directoryRuleMarkers", "isolated"])
                             for turn in cohort.get("turns", [])]
        selected["hooks"] = hooks(cohort)
        config = cohort.get("directoryConfiguration", {})
        selected.update(pick(config, ["hookScope", "trustCondition"]))
        selected["projectRuleFiles"] = sorted({revision["projectRuleFile"]
                                               for revision in config.get("revisions", [])})
        release = cohort.get("releasedDirectory", {})
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
        for cohort in evidence[field]:
            selected = pick(cohort, ["scenario", "mode", "observed", "bInvocation", "aInvocation",
                                     "aHookObserved", "bHookObserved", "bNativeOutputRetained",
                                     "aBypassHookTrust", "bBypassHookTrust", "scope"])
            selected["newSessionMarkers"] = cohort.get("newSession", {}).get("directoryRuleMarkers")
            selected["hooks"] = hooks(cohort)
            selected["errorRecorded"] = "error" in cohort
            if field == "configurationFollowup":
                wait = next((wait for wait in cohort.get("waits", [])
                             if wait.get("label") == "configuration settling before B open"), {})
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
