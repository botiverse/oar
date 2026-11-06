"""Summarize downloaded comparison artifacts without discarding failures.

Usage: python3 experiments/windows-codex-ci/analyze.py DOWNLOAD_DIRECTORY > summary.json
One environment.json per runner. Missing/partial diagnostics remain explicit.
"""
import collections
import datetime
import json
import math
from pathlib import Path
import statistics
import sys


def distribution(values):
    values = sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v))
    if not values:
        return {"n": 0}
    return {"n": len(values), "min": values[0], "median": statistics.median(values),
            "p95NearestRank": values[math.ceil(len(values) * .95) - 1], "max": values[-1]}


def load_lines(paths):
    rows, gaps = [], []
    for path in paths:
        for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("expected an object")
                rows.append(row)
            except ValueError:
                gaps.append({"file": path.name, "line": line_number})
    return rows, gaps


def phase_key(row):
    return (row["pid"], row.get("file"), row.get("workerId"), row["id"], row["phase"])


def seconds(row):
    return datetime.datetime.fromisoformat(row["at"].replace("Z", "+00:00")).timestamp()


def runner(environment_path):
    directory = environment_path.parent
    env = json.loads(environment_path.read_text(encoding="utf-8-sig"))
    versions_path = directory / "versions.json"
    versions = json.loads(versions_path.read_text(encoding="utf-8-sig")) if versions_path.exists() else None
    rows, gaps = load_lines(sorted(directory.glob("phases-*.jsonl")))
    resources, resource_gaps = load_lines(directory.glob("resources.jsonl"))
    starts = {phase_key(r): r for r in rows if r["kind"] == "phase_start"}
    ends = {phase_key(r): r for r in rows if r["kind"] == "phase_end"}
    phases = collections.defaultdict(list)
    for row in ends.values():
        phases[row["phase"]].append(row["elapsedMs"])
    test_ends = [r for r in rows if r["kind"] == "test_end"]
    exits = [r for r in rows if r["kind"] == "vitest_exit"]
    launches = [r for r in rows if r["kind"] == "vitest_launch"]
    counters = collections.defaultdict(list)
    for row in resources:
        if row["kind"] == "counters":
            for value in row["values"]:
                # PDH valid-data and new-data statuses are usable measurements.
                if value["status"] in (0, 1):
                    counters[value["counter"]].append(value["value"])
    entered = [r for r in rows if r["kind"] == "worker_file_entered"]
    module_ends = {r["file"]: r for r in rows if r["kind"] == "module_end"}
    intervals = []
    for row in entered:
        end = module_ends.get(row.get("file"))
        if end is not None:
            intervals.extend([(seconds(row), 1), (seconds(end), -1)])
    active = peak = 0
    for _, delta in sorted(intervals):
        active += delta
        peak = max(peak, active)
    return {
        "artifact": environment_path.relative_to(Path(sys.argv[1])).as_posix(),
        "environment": env, "versions": versions,
        "vitestConfig": [r for r in rows if r["kind"] == "vitest_config"],
        "vitestExit": exits[-1] if exits else None,
        "vendorWallSeconds": seconds(exits[-1]) - seconds(launches[0]) if exits and launches else None,
        "testStates": dict(collections.Counter(r["state"] for r in test_ends)),
        "tests": [{k: r.get(k) for k in ("file", "test", "state", "elapsedMs")} for r in test_ends],
        "phasesMs": {key: distribution(values) for key, values in sorted(phases.items())},
        "unendedPhases": [{k: r.get(k) for k in ("phase", "file", "test", "at", "pid", "id")}
                          for key, r in starts.items() if key not in ends],
        "poolSlotsObserved": sorted({r["poolId"] for r in entered if r.get("poolId") is not None}),
        "fileWorkerPidsObserved": len({r["pid"] for r in entered}),
        "peakObservedFileIntervals": peak,
        "filesWithoutModuleEnd": [r.get("file") for r in entered if r.get("file") not in module_ends],
        "resourceSamples": dict(collections.Counter(r["kind"] for r in resources)),
        "counters": {key: distribution(values) for key, values in sorted(counters.items())},
        "malformedLines": gaps + resource_gaps,
    }


if __name__ == "__main__":
    root = Path(sys.argv[1])
    results = [runner(p) for p in sorted(root.rglob("environment.json")) if p.parent.name == "codex-comparison"]
    counts = collections.Counter((r["environment"]["group"], str(r["environment"]["replica"])) for r in results)
    expected = {(group, str(replica)) for group in ("default", "2", "1") for replica in (1, 2, 3)}
    comparable_fields = ("sha", "lockSha256", "baseConfigSha256", "ciWorkflowSha256", "coldStartTestSha256", "imageOS", "imageVersion", "node", "platform", "availableParallelism", "totalMemoryBytes")
    differences = {key: sorted({str(r["environment"].get(key)) for r in results}) for key in comparable_fields}
    summary = {
        "runnerCount": len(results),
        "missingRunnerSlots": sorted(expected - counts.keys()),
        "duplicateRunnerSlots": [slot for slot, count in counts.items() if count > 1],
        "unexpectedRunnerSlots": sorted(counts.keys() - expected),
        "cohortValues": differences,
        "installedVersions": [r["versions"] for r in results],
        "runners": results,
        "interpretation": "Inspect each attempt, version/image and missing trace before comparing groups. Nine green jobs cannot establish a root cause. File intervals include reporter delay; pool slots are observed, not a claim about concurrent native sessions.",
    }
    print(json.dumps(summary, indent=2, allow_nan=False))
