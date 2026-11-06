"""Select an unpacked CodeBuddy install diagnostic without exposing local paths."""
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

source = Path(sys.argv[1])
phases_path = source / "phases.jsonl"
phases = [json.loads(line) for line in phases_path.read_text().splitlines()]
selected = [
    {key: phase[key] for key in ("phase", "at", "timeoutMs", "kind", "ok") if key in phase}
    for phase in phases
]
by_name = {phase["phase"]: phase for phase in phases}


def elapsed(start, end):
    if start not in by_name or end not in by_name:
        return None
    earlier = datetime.fromisoformat(by_name[start]["at"].replace("Z", "+00:00"))
    later = datetime.fromisoformat(by_name[end]["at"].replace("Z", "+00:00"))
    return round((later - earlier).total_seconds() * 1000)


sample = {
    "phases": selected,
    "installMs": elapsed("install_started", "install_returned"),
    "verificationMs": elapsed("verification_started", "verification_completed"),
    "cleanupMs": elapsed("cleanup_started", "cleanup_finished"),
    "sourceSha256": {phases_path.name: hashlib.sha256(phases_path.read_bytes()).hexdigest()},
    "npmTimings": [],
    "registryTarballFetches": [],
}
for file in sorted(source.glob("*-timing.json")):
    data = json.loads(file.read_text())
    sample["sourceSha256"][file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
    sample["npmTimings"].append({
        "version": data.get("metadata", {}).get("version"),
        "timersMs": {
            key: data["timers"][key]
            for key in ("idealTree", "reify:unpack", "reify:build", "build:link", "reify", "command:install", "npm")
            if key in data.get("timers", {})
        },
    })
for file in sorted(source.glob("*-debug-*.log")):
    sample["sourceSha256"][file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
    for line in file.read_text().splitlines():
        # Select only public registry tarballs; omit arbitrary URLs and paths.
        hit = re.search(r"http fetch GET (\d+) https://registry\.npmjs\.org/([@A-Za-z0-9_.%/+-]+\.tgz) (\d+)ms \(cache (miss|hit)\)", line)
        if hit:
            sample["registryTarballFetches"].append({
                "status": int(hit[1]), "tarball": hit[2],
                "durationMs": int(hit[3]), "cache": hit[4],
            })
Path(sys.argv[2]).write_text(json.dumps(sample, indent=2) + "\n")
