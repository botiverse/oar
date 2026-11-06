"""Select reviewable, payload-free evidence from the complete first-round artifacts.

Usage: python3 summarize.py DOWNLOAD_DIRECTORY jobs.json artifacts.json > results.json
The two API snapshots come from the same run. Raw artifacts stay unchanged.
"""
import collections
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True

from analyze import distribution, load_lines, runner

root = Path(sys.argv[1])
jobs = json.loads(Path(sys.argv[2]).read_text())["jobs"]
archives = json.loads(Path(sys.argv[3]).read_text())["artifacts"]
expected = {(group, str(replica)) for group in ("default", "2", "1") for replica in (1, 2, 3)}
results = [runner(p) for p in sorted(root.rglob("environment.json")) if p.parent.name == "codex-comparison"]
counts = collections.Counter((r["environment"]["group"], r["environment"]["replica"]) for r in results)
fields = ("sha", "runId", "runAttempt", "lockSha256", "baseConfigSha256", "ciWorkflowSha256",
          "coldStartTestSha256", "imageOS", "imageVersion", "node", "platform",
          "availableParallelism", "totalMemoryBytes")
cohort = {key: sorted({str(r["environment"].get(key)) for r in results}) for key in fields}
selected = []
for r in results:
    env = r["environment"]
    group, replica = env["group"], env["replica"]
    name = f"Windows Codex ({group}, replica {replica})"
    matches = [job for job in jobs if job["name"] == name]
    assert len(matches) == 1, f"Expected exactly one job for {name}"
    job = matches[0]
    selected.append({
        "group": group, "replica": replica, "jobId": job["id"], "jobUrl": job["html_url"],
        "conclusion": job["conclusion"], "steps": [{k: step.get(k) for k in
            ("name", "conclusion", "started_at", "completed_at")} for step in job["steps"]],
        "versions": r["versions"], "vendorWallSeconds": r["vendorWallSeconds"],
        "vitestConfig": [{k: item.get(k) for k in
            ("pool", "requestedWorkers", "configuredMaxWorkers", "testTimeout", "hookTimeout")} for item in r["vitestConfig"]],
        "testStates": r["testStates"], "failedTests": [t for t in r["tests"] if t["state"] == "failed"],
        "coldStartTests": [t for t in r["tests"] if "concurrent sessions initialize one fresh home" in (t["test"] or "")],
        "phasesMs": r["phasesMs"], "counters": r["counters"],
        "poolSlotsObserved": r["poolSlotsObserved"], "fileWorkerPidsObserved": r["fileWorkerPidsObserved"],
        "peakObservedFileIntervals": r["peakObservedFileIntervals"], "resourceSamples": r["resourceSamples"],
        "unendedPhases": r["unendedPhases"], "filesWithoutModuleEnd": r["filesWithoutModuleEnd"],
        "malformedLines": r["malformedLines"],
    })

failure_directory = root / "windows-codex-1-1" / "codex-comparison"
# Artifacts may contain an additional oar-trial-run directory.
if not failure_directory.exists():
    failure_directory = next((root / "windows-codex-1-1").rglob("environment.json")).parent
phase_files = sorted(failure_directory.glob("phases-*.jsonl"))
rows, gaps = load_lines(phase_files)
assert not gaps
case_name = "codex correlates native steer echo without a duplicate input"
failure_rows = sorted((r for r in rows if case_name in (r.get("test") or "")), key=lambda r: r["at"])
keys = ("at", "monotonicMs", "pid", "workerId", "poolId", "file", "test", "kind", "id", "phase",
        "elapsedMs", "outcome", "response", "frameType", "events", "outcomes", "seq", "state")
timeline = [{k: r[k] for k in keys if k in r} for r in failure_rows]
late_cleanup = [r for r in failure_rows if r.get("phase") == "fixture.stop.directory"]
assert len(late_cleanup) == 2
start, end = late_cleanup[0]["at"], late_cleanup[1]["at"]
resources, gaps = load_lines([failure_directory / "resources.jsonl"])
assert not gaps
window_samples = [r for r in resources if r["kind"] == "counters" and start <= r["at"] <= end]
counters = collections.defaultdict(list)
for row in window_samples:
    for value in row["values"]:
        if value["status"] in (0, 1):
            counters[value["counter"]].append(value["value"])
next_warmup = sorted((r for r in rows if "codex correlates native fallback echo without a duplicate input" in (r.get("test") or "")
                      and r.get("phase") in ("warmup.initialize", "fixture.prepare")), key=lambda r: r["at"])

def digest(path):
    return {"file": path.relative_to(root).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

print(json.dumps({
    "runUrl": "https://github.com/botiverse/oar/actions/runs/42237872904", "attempt": 1,
    "runnerCount": len(results), "missingSlots": sorted(expected - counts.keys()),
    "duplicateSlots": [slot for slot, count in counts.items() if count > 1],
    "unexpectedSlots": sorted(counts.keys() - expected), "cohort": cohort,
    "archives": [{k: a[k] for k in ("name", "id", "size_in_bytes", "digest", "expires_at")} for a in archives],
    "runners": selected,
    "failureEvidence": {"timeline": timeline,
        "followingWarmup": [{k: r[k] for k in keys if k in r} for r in next_warmup],
        "directoryRemovalWindowCounters": {k: distribution(v) for k, v in sorted(counters.items())},
        "directoryRemovalWindowSamples": window_samples,
        "rawFiles": [digest(p) for p in phase_files + [failure_directory / "resources.jsonl"]]},
}, indent=2, allow_nan=False))
