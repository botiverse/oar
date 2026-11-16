"""Verify and select native synthetic evidence; raw inputs remain local."""
import hashlib
import json
import pathlib
import sys

main_path, socket_path, comparison_path = map(pathlib.Path, sys.argv[1:4])
main = json.loads(main_path.read_text())
socket = json.loads(socket_path.read_text())
assert not main.get("failure") and not socket.get("failure")
assert main["installation"]["version"] == "codex-cli 0.169.0"
assert socket["installation"]["version"] == "codex-cli 0.169.0"
tokens = main["tokens"]
selected_phases = []
previous = 0
for phase in main["phases"]:
    children = phase["childrenThroughPhase"][previous:]
    previous = len(phase["childrenThroughPhase"])
    mcps = [row for row in children if row["kind"] == "mcp-call"]
    shells = [row for row in children if row["kind"] == "shell"]
    assert len(shells) == 2
    assert len(phase["turns"]) == 4
    assert all(row["turn"]["status"] == "completed" for row in phase["turns"])
    omitted = phase["phase"] == "resume-omitted"
    if omitted:
        assert not mcps
        assert not any(row["kind"] == "mcp-start" for row in children)
    else:
        assert len(mcps) == 2 and len({row["instance"] for row in mcps}) == 2
        for row in mcps:
            assert row["env"]["OAR_MCP_TOKEN"] == tokens["mcp" + row["input"]]
            assert row["env"]["OAR_SHELL_TOKEN"] is None
            assert row["env"]["OAR_UNLISTED_CONTROL"] is None
            assert row["env"]["OAR_ALLOWED_CONTROL"] == tokens["allowed"]
    for label, row in zip(["A", "B"], shells, strict=True):
        assert row["env"]["OAR_SHELL_TOKEN"] == (None if omitted else tokens["shell" + label])
        assert row["env"]["OAR_MCP_TOKEN"] == tokens["processDefault"]
        assert row["env"]["OAR_UNLISTED_CONTROL"] == tokens["unlisted"]
    selected_phases.append({"phase": phase["phase"], "turnsCompleted": 4,
                            "children": [{k: v for k, v in row.items() if k != "pid"} for row in children]})

scans = []
for scan in main["scans"]:
    assert all("error" not in entry and not entry.get("nonRegular") for entry in scan["files"])
    matches = [entry for entry in scan["files"] if entry["hits"]]
    assert all(not set(entry["hits"]) & {"mcpA", "mcpB", "shellA", "shellB"} for entry in scan["files"])
    scans.append({"phase": scan["phase"], "filesRead": len(scan["files"]),
                  "bytesRead": sum(entry["bytes"] for entry in scan["files"]), "matches": matches,
                  "sqliteFiles": [entry["file"] for entry in scan["files"] if ".sqlite" in entry["file"]]})
assert any(scan["matches"] for scan in scans)
assert len(main["providerScans"]) == 24
assert all(not row["hits"] for row in main["providerScans"] + socket["providerScans"])

reads = []
for row in socket["childReads"]["rows"]:
    frame = row["frame"]
    assert "error" not in frame
    text = json.dumps(frame)
    assert all(token not in text for token in socket["tokens"].values())
    result = frame["result"]
    reads.append({"method": row["method"], "includeTurns": row["params"].get("includeTurns"),
                  "responseKeys": list(result), "containsPeerPrompt": "OAR_SHARE_B_echo" in text,
                  "tokenHits": [], "peerTurns": result.get("thread", {}).get("turns")})
assert all(row["containsPeerPrompt"] for row in reads if row["method"] in {"thread/list", "thread/read"})

selected = {"runtime": "codex-cli 0.169.0", "platform": main["platform"], "syntheticTokens": tokens,
            "phases": selected_phases, "recursiveHomeScans": scans,
            "providerPayloads": {"stdioRequests": len(main["providerScans"]), "socketRequests": len(socket["providerScans"]), "tokenHits": []},
            "socketTransport": socket["transport"], "modelInvokedShellReads": reads,
            "sourceComparison": json.loads(comparison_path.read_text()),
            "rawManifest": [{"name": name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                            for name, p in [("stdio-evidence.json", main_path), ("socket-evidence.json", socket_path), ("source-comparison.json", comparison_path)]]}
# Native identifiers are synthetic, but use stable labels for readable snapshots.
text = json.dumps(selected, indent=2)
ids = [call["result"]["thread"]["id"] for call in main["native"]["calls"] if call["method"] == "thread/start"]
ids += [call["result"]["thread"]["id"] for call in socket["calls"] if call["method"] == "thread/start"]
for index, native_id in enumerate(ids):
    text = text.replace(native_id, f"THREAD_{index}")
pathlib.Path(__file__).with_name("selected.json").write_text(text + "\n")
print("Verified native environment, restart, full-home scan and model-shell read observations.")
