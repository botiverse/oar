"""Read GitHub job metadata through Stamp; never fetch command logs or secrets.

python3 experiments/windows-ci-duration-audit.py --stamp /path/to/stamp \
    --job JOB_ID --job ANOTHER_JOB_ID
Durations end at GitHub's completion timestamp, not the last runner heartbeat.
"""

import argparse
import concurrent.futures
import datetime
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--stamp", default="stamp")
parser.add_argument("--job", type=int, action="append", required=True)
parser.add_argument("--output", default="oar-trial-run/windows-ci-duration")
args = parser.parse_args()
output = pathlib.Path(args.output)
output.mkdir(parents=True, exist_ok=True)


def fetch(endpoint):
    result = subprocess.run(
        [args.stamp, "api", endpoint], check=True, capture_output=True, text=True
    )
    return json.loads(result.stdout)


def seconds(start, end):
    if not start or not end:
        return None
    return int((datetime.datetime.fromisoformat(end.replace("Z", "+00:00"))
                - datetime.datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds())


def inspect(job_id):
    job = fetch(f"repos/botiverse/oar/actions/jobs/{job_id}")
    (output / f"job-{job_id}.json").write_text(json.dumps(job, indent=2) + "\n")
    stages = [{
        "name": step["name"], "status": step["status"],
        "conclusion": step.get("conclusion"),
        "startedAt": step.get("started_at"), "completedAt": step.get("completed_at"),
        "seconds": seconds(step.get("started_at"), step.get("completed_at")),
    } for step in job.get("steps", []) if "sea-trial" in step["name"] or "Pi RPC" in step["name"]]
    return {
        "job": job_id, "run": job["run_id"], "url": job["html_url"],
        "name": job["name"], "conclusion": job["conclusion"],
        "startedAt": job["started_at"], "completedAt": job["completed_at"],
        "seconds": seconds(job["started_at"], job["completed_at"]), "stages": stages,
    }


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    summaries = list(pool.map(inspect, args.job))
(output / "summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
for item in summaries:
    print(item["job"], item["conclusion"], item["seconds"], "seconds")
