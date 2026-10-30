"""Read CI job attempts through gh; never dispatch, rerun or cancel a job."""

import argparse
import concurrent.futures
import csv
import datetime
import json
import pathlib
import subprocess
import time
import urllib.parse


def api(endpoint):
    for attempt in range(3):
        result = subprocess.run(
            ["gh", "api", endpoint], capture_output=True, text=True, timeout=60
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        if not any(reason in result.stderr for reason in (
            "HTTP 50", "stream error", "connection reset", "TLS handshake timeout"
        )):
            break
        time.sleep(attempt + 1)
    raise RuntimeError(f"{endpoint}: {result.stderr}")


def pages(endpoint, field):
    values = []
    for page in range(1, 1001):
        response = api(f"{endpoint}&per_page=100&page={page}")
        batch = response[field]
        values.extend(batch)
        if len(batch) < 100:
            if len(values) != response["total_count"]:
                raise RuntimeError(f"Incomplete inventory for {endpoint}")
            return values
    raise RuntimeError(f"Pagination did not finish for {endpoint}")


def job_row(run, job):
    messages = [item["message"] for item in job.get("annotations", [])]
    limit = next((m for m in messages if "maximum execution time" in m), "")
    admin = next((m for m in messages if "The run was canceled by" in m), "")
    vendor = next((s for s in job["steps"] if s["name"].startswith("Pi RPC vendor")), {})
    start, end = job["started_at"], job["completed_at"]
    duration = (datetime.datetime.fromisoformat(end) - datetime.datetime.fromisoformat(start)).total_seconds() if end else None
    return {
        "run_id": run["id"], "job_id": job["id"], "attempt": job["run_attempt"],
        "event": run["event"], "head": run["head_sha"], "run_created_at": run["created_at"],
        "job_started_at": start, "job_completed_at": end, "duration_seconds": duration,
        "conclusion": job["conclusion"], "vendor_started_at": vendor.get("started_at"),
        "vendor_completed_at": vendor.get("completed_at"), "vendor_status": vendor.get("status"),
        "vendor_conclusion": vendor.get("conclusion"),
        "classification": "job_limit" if limit else "administrative_cancel" if admin else job["conclusion"] or "in_progress",
        "annotation": limit or admin,
    }


def write_csv(path, rows):
    if not rows:
        raise RuntimeError(f"No rows for {path}")
    with path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="Inclusive workflow creation time, UTC ISO8601")
    parser.add_argument("--until", required=True, help="Inclusive workflow creation time, UTC ISO8601")
    parser.add_argument("--out", type=pathlib.Path, required=True, help="New local output directory")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    prefix = "repos/botiverse/oar"
    period = urllib.parse.quote(f"{args.since}..{args.until}", safe="")
    runs = pages(f"{prefix}/actions/workflows/ci.yml/runs?created={period}", "workflow_runs")

    def collect(run):
        # filter=all preserves failed attempts that a successful rerun replaced.
        jobs = pages(f"{prefix}/actions/runs/{run['id']}/jobs?filter=all", "jobs")
        selected = [job for job in jobs if job["name"] == "pi-rpc-windows (vendor)"]
        for job in selected:
            if job["conclusion"] in ("cancelled", "timed_out", "failure"):
                check_id = job["check_run_url"].rsplit("/", 1)[1]
                annotations = []
                page = 1
                while True:
                    batch = api(f"{prefix}/check-runs/{check_id}/annotations?per_page=100&page={page}")
                    annotations.extend(batch)
                    if len(batch) < 100:
                        break
                    page += 1
                job["annotations"] = annotations
        result = {"run": run, "jobs": selected, "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        (args.out / f"{run['id']}.json").write_text(json.dumps(result, indent=2) + "\n")
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(collect, runs))
    rows = [job_row(r["run"], job) for r in results for job in r["jobs"]]
    if len({row["job_id"] for row in rows}) != len(rows):
        raise RuntimeError("Duplicate job attempts")
    write_csv(args.out / "jobs.csv", sorted(rows, key=lambda row: (row["job_started_at"], row["job_id"])))
    write_csv(args.out / "runs.csv", [
        {**{key: r["run"][key] for key in ("id", "head_sha", "event", "created_at", "run_attempt")}, "vendor_jobs": len(r["jobs"])}
        for r in sorted(results, key=lambda r: r["run"]["created_at"])
    ])
    print(f"Collected {len(runs)} workflows and {len(rows)} vendor job attempts into {args.out}")


if __name__ == "__main__":
    main()
