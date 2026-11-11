# Antigravity MCP failure evidence

2026-11-11, Linux x64, Node 24.19.0, real agy CLI 1.5.0 from the checksum-pinned
CI installer. Provider responses came from local aimock; the fixture used a
fresh HOME and synthetic credentials. No account or remote model was used.

The name-clash case must keep asserting both echo results. A missing native
tool catalog is a failure, not a reason to retry or delay that assertion.
This change records evidence needed to investigate the next failure; it does
not explain or fix the macOS catalog omission.

## Observations

The unmodified case passed. A temporary copy with only its expected second
echo changed to `forced-assertion-failure` failed with the original
`AssertionError` and exit code 1. After the fixture HOME was removed, its
artifact still contained the front and worker native logs and all three
MCP metadata files. Each server recorded startup, initialize reply and
`tools/list` reply. The two servers actually used by the session also
recorded `tools/call`. The shadowed user `echo` server recorded shutdown.
An abrupt native termination need not deliver a Node exit event.

[Selected results](selected.json) contain file sizes and metadata events,
without machine paths, process IDs, RPC IDs, arguments or payloads. The
passing run created no `agy-mcp-failure` directory. The full applicable
Antigravity vendor suite also passed; see the selected results for counts.
The original macOS failure was not reproduced by this validation.

The first capture exercise exposed a sanitizer ordering bug: replacing the
synthetic key `aimock` before replacing HOME changed a directory component,
so the full path no longer matched. Path replacement now happens first;
the retention test uses a directory containing that key to guard this case.
Restoring the incorrect order made that regression fail; restoring the fix
passed all five targeted tests.
The final native capture contained neither the fixture paths nor the known
synthetic credentials. Earlier capture attempts are not the selected result.

## Retention contract

Only this Antigravity vendor case opts in. The echo fixture records fixed
startup, handshake and shutdown metadata to temporary files, at most 64 KiB
per process, without adding a proxy process or reading stdin twice. A broken
recorder leaves protocol replies unchanged.

On failure, after session disposal and before HOME cleanup, the helper reads
up to four regular `.log` files directly under
`$GEMINI_HOME/antigravity-cli/log/`. Each read is limited to a 512 KiB tail;
incomplete lines and partial native entries at the boundary are discarded.
No settings, authentication files, databases or conversation files are copied.
Known paths and credential values are removed. Credential-bearing native
entries, including multiline continuations, are omitted; URLs and recognizable
credential prefixes are redacted. This is for the isolated synthetic fixture,
not a general exporter for logs from real accounts.

Artifacts go to `OAR_TRIAL_RUN_DIR/agy-mcp-failure/<capture-id>/`, already
covered by the CI `agy-acp-*` upload. The manifest distinguishes unavailable
files, an unreadable native log directory and truncation. A missing metadata
file means startup was not observed; it cannot prove that spawn never happened.
Collection failures warn without replacing the original assertion. Temporary
MCP metadata is removed after both success and failure.

## Replay

Use an isolated checkout with Node 24+, dependencies installed, and
`OAR_ANTIGRAVITY_BIN` pointing to CLI 1.5.0. From the repository root:

```sh
CI=1 pnpm vitest run tests/antigravity-mcp-evidence.test.ts
CI=1 OAR_TEST=antigravity-aimock OAR_TEST_REQUIRE_AVAILABLE=1 \
  OAR_TRIAL_RUN_DIR="$PWD/oar-trial-run/agy-capture-pass" \
  pnpm vitest run sea-trial/vendor/mcp-servers-acp.vendor.test.ts \
  -t 'a server named like'
```

The five automated tests cover multiline and escaped credential keys, paths
containing the synthetic key, bounded copies, cropped entries, missing files,
an unwritable output directory, and the real echo process with working and
broken recorders.

To exercise the native failure path without changing the checked-in test,
run this Python 3 snippet from the repository root. It makes a temporary copy
beside the original so relative imports resolve, changes only an expected
value, runs that copy, then removes it. Do not run another test suite concurrently
while the temporary copy exists. Exit 1 from Vitest is expected.

```python
from pathlib import Path
import json
import os
import subprocess
import tempfile

source = Path("sea-trial/vendor/mcp-servers-acp.vendor.test.ts").read_text()
needle = "`echo:clash-user via=stdio token=${fingerprint(USER_TOKEN)}`"
assert source.count(needle) == 1
with tempfile.NamedTemporaryFile(mode="w", dir="sea-trial/vendor",
        prefix="agy-evidence-probe-", suffix=".vendor.test.ts", delete=False) as f:
    f.write(source.replace(needle,
        "`echo:forced-assertion-failure via=stdio token=${fingerprint(USER_TOKEN)}`"))
    test = Path(f.name)
with tempfile.TemporaryDirectory(prefix="agy-capture-result-") as result:
    env = os.environ | {"CI": "1", "OAR_TEST": "antigravity-aimock",
        "OAR_TEST_REQUIRE_AVAILABLE": "1", "OAR_TRIAL_RUN_DIR": result}
    try:
        run = subprocess.run(["pnpm", "vitest", "run", str(test),
            "-t", "a server named like"], env=env, check=False)
        assert run.returncode == 1
        captures = list(Path(result).glob("agy-mcp-failure/*"))
        assert len(captures) == 1
        manifest = json.loads((captures[0] / "manifest.json").read_text())
        assert manifest["nativeDirectoryReadable"]
        assert {f["kind"] for f in manifest["files"]} == {"front", "worker", "mcp"}
        assert all("error" not in f for f in manifest["files"])
        for name in ["session-echo", "user-echo", "userecho"]:
            events = [json.loads(line) for line in
                (captures[0] / (name + ".jsonl")).read_text().splitlines()]
            assert any(e["event"] == "started" for e in events)
            assert any(e["event"] == "replied" and e.get("method") == "initialize"
                for e in events)
            assert any(e["event"] == "replied" and e.get("method") == "tools/list"
                for e in events)
        print(json.dumps(manifest, indent=2))
    finally:
        test.unlink()
```
