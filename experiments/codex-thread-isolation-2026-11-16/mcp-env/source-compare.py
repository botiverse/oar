"""Fetch only public pinned upstream sources and retain their fingerprints."""
import hashlib
import json
import pathlib
import sys
import urllib.request

out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rows = []
for name in ["rmcp-client/src/utils.rs", "codex-mcp/src/server.rs", "hooks/src/registry.rs"]:
    file = "codex-rs/" + name
    sources = {}
    for label, revision in [("pinned", "d32063f96c2dff1dc96af839b3952abb6acfeda4"), ("main", "75fc67e8")]:
        url = f"https://raw.githubusercontent.com/openai/codex/{revision}/{file}"
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read()
        sources[label] = data
        (out / (label + "-" + name.replace("/", "-"))).write_bytes(data)
    rows.append({"path": file, "sameBytes": sources["main"] == sources["pinned"],
                 "mainSHA256": hashlib.sha256(sources["main"]).hexdigest(),
                 "pinnedSHA256": hashlib.sha256(sources["pinned"]).hexdigest()})
(out / "comparison.json").write_text(json.dumps(rows, indent=2))
