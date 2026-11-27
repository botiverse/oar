import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { planInstaller, scriptInstallPlan, type InstallHost } from "../packages/oar/src/shared/install.js";
import { parseScriptInstallLine } from "../packages/oar/src/shared/install-script.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-install-script-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  vi.stubEnv("no_proxy", "127.0.0.1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface HttpReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string | Buffer;
}

const linux: InstallHost = { platform: "linux", arch: "x64", locate: (tool) => `/usr/bin/${tool}`, unwritable: () => null };
const scriptTempPrefix = `oar-install-script-${String(process.pid)}-`;

function assertNoScriptTempDirs(): void {
  assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith(scriptTempPrefix)), []);
}

function fixtureRoutes(): Readonly<Record<string, HttpReply>> {
  const target = path.join(dir, "scripted-tool");
  const argsFile = path.join(dir, "script-args.txt");
  const canary = path.join(dir, "html-executed-canary");
  const okBody = [
    "#!/bin/sh",
    "set -eu",
    `printf '%s|%s\\n' "$INSTALL_MODE" "$1" > ${JSON.stringify(argsFile)}`,
    `printf '#!/bin/sh\\necho ok\\n' > ${JSON.stringify(target)}`,
    "echo installed-via-stdin",
  ].join("\n");
  return {
    "/ok.sh": { status: 200, contentType: "text/plain", body: okBody },
    "/html": { status: 200, contentType: "text/html", body: `<!DOCTYPE html><html><body>$(touch ${canary})</body></html>\n` },
    "/comment-html": { status: 200, contentType: "text/html", body: "<!-- gateway -->\n<!DOCTYPE html><html></html>\n" },
    "/redos-comments": { status: 200, contentType: "text/plain", body: `${"<!---->".repeat(73)}x` },
    "/bom-shebang": { status: 200, contentType: "text/plain", body: "\uFEFF#!/bin/sh\necho bom\n" },
    "/one-byte": { status: 200, contentType: "text/plain", body: "#" },
    "/binary": { status: 200, contentType: "application/octet-stream", body: Buffer.from([0x00, 0x01, 0x02, 0x03]) },
    "/text": { status: 200, contentType: "text/plain", body: "Access Denied\n" },
    "/empty": { status: 200, contentType: "text/plain", body: "" },
    "/fail-script.sh": { status: 200, contentType: "application/x-sh", body: "#!/bin/sh\necho dying >&2\nexit 42\n" },
    "/slow-script.sh": { status: 200, contentType: "application/x-sh", body: "#!/bin/sh\nsleep 10\n" },
  };
}

function createFixtureServer(): ReturnType<typeof createServer> {
  const routes = fixtureRoutes();
  return createServer((req, res) => {
    if (req.url === "/slow-download") {
      res.writeHead(200, { "content-type": "text/plain" });
      return;
    }
    const reply = routes[req.url ?? "/"] ?? { status: 404, contentType: "text/plain", body: "Not Found\n" };
    res.writeHead(reply.status, { "content-type": reply.contentType }).end(reply.body);
  });
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    assert.ok(addr !== null && typeof addr !== "string");
    await run(`http://127.0.0.1:${String(addr.port)}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr !== null && typeof addr !== "string");
  server.close();
  await once(server, "close");
  return addr.port;
}

function makeHarness(host: InstallHost = linux): {
  readonly probeCount: { count: number };
  readonly runLine: (line: string, timeoutMs?: number) => ReturnType<ReturnType<typeof planInstaller>>;
} {
  const target = path.join(dir, "scripted-tool");
  const probeCount = { count: 0 };
  const probe: Parameters<typeof planInstaller>[0] = async () => {
    await Promise.resolve();
    probeCount.count += 1;
    return existsSync(target)
      ? { kind: "available", via: "executable", command: target, version: "fake 2.3.4" }
      : { kind: "not_found" };
  };
  const runLine = async (line: string, timeoutMs?: number): ReturnType<ReturnType<typeof planInstaller>> => {
    const plan = scriptInstallPlan({
      source: "https://example.invalid/docs", line, tools: ["curl", "sh"], writes: () => [dir], windows: "PowerShell",
    }, host);
    return planInstaller(probe, plan)(timeoutMs === undefined ? undefined : { timeoutMs });
  };
  return { probeCount, runLine };
}

test("parseScriptInstallLine rejects unsupported or shell-metacharacter commands", () => {
  assert.throws(() => parseScriptInstallLine("wget https://example.invalid/install.sh | sh"));
  assert.throws(() => parseScriptInstallLine("curl -fsSL https://example.invalid/install.sh | bash -c id"));
  assert.throws(() => parseScriptInstallLine("curl -fsSL https://example.invalid/install.sh | bash -c 'touch /tmp/x'"));
  assert.throws(() => parseScriptInstallLine("curl -fsSL https://example.invalid/install.sh | FOO=bar;rm sh"));
});

test.skipIf(process.platform === "win32")("download failures report curl exit code or spawn failure and skip post-install probe", async () => {
  const closedPort = await unusedPort();
  await withServer(async (baseUrl) => {
    const harness = makeHarness();
    const http404 = await harness.runLine(`curl -fsSL ${baseUrl}/missing | sh`);
    assert.deepEqual([http404.kind, http404.kind === "failed" ? http404.reason : undefined, http404.kind === "failed" ? http404.exitCode : undefined], ["failed", "download_failed", 22]);
    assert.equal(harness.probeCount.count, 1);

    harness.probeCount.count = 0;
    const refused = await harness.runLine(`curl -fsSL http://127.0.0.1:${String(closedPort)}/install.sh | sh`);
    assert.equal(refused.kind, "failed");
    assert.equal(refused.reason, "download_failed");
    assert.ok(refused.exitCode !== null && refused.exitCode !== 0);
    assert.equal(harness.probeCount.count, 1);
  });
});

test.skipIf(process.platform === "win32")("curl ENOENT during install reports download_failed with null exitCode and cleans temp dir", async () => {
  const emptyBin = path.join(dir, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  vi.stubEnv("PATH", emptyBin);
  const harness = makeHarness({ ...linux, locate: (tool) => `/usr/bin/${tool}` });
  const missingCurl = await harness.runLine("curl -fsSL http://127.0.0.1:1/install.sh | sh");
  assert.deepEqual([missingCurl.kind, missingCurl.kind === "failed" ? missingCurl.reason : undefined, missingCurl.kind === "failed" ? missingCurl.exitCode : undefined], ["failed", "download_failed", null]);
  assert.equal(harness.probeCount.count, 1);
  assertNoScriptTempDirs();
});

test.skipIf(process.platform === "win32")("non-script responses (including HTML comments, BOM, 1-byte, binary, and empty) refuse execution fast", async () => {
  const cases = [
    ["/html", /did not start with #!.*looks like HTML/u, null],
    ["/comment-html", /did not start with #!.*looks like HTML/u, null],
    ["/redos-comments", /did not start with #!/u, /HTML/u],
    ["/bom-shebang", /did not start with #!/u, /HTML/u],
    ["/one-byte", /1 byte\)/u, /bytes/u],
    ["/binary", /4 bytes\)/u, /HTML/u],
    ["/text", /did not start with #!/u, /HTML/u],
    ["/empty", /empty \(0 bytes\)/u, null],
  ] as const;
  await withServer(async (baseUrl) => {
    const startedAt = Date.now();
    await Promise.all(cases.map(async ([route, mustMatch, mustNotMatch]) => {
      const harness = makeHarness();
      const result = await harness.runLine(`curl -fsSL ${baseUrl}${route} | sh`);
      assert.deepEqual([result.kind, result.kind === "failed" ? result.reason : undefined, result.kind === "failed" ? result.exitCode : undefined], ["failed", "non_script_response", null]);
      assert.match(result.kind === "failed" ? result.output : "", mustMatch);
      if (mustNotMatch !== null) { assert.doesNotMatch(result.kind === "failed" ? result.output : "", mustNotMatch); }
      assert.equal(harness.probeCount.count, 1);
    }));
    assert.ok(Date.now() - startedAt < 5000);
    assert.equal(existsSync(path.join(dir, "html-executed-canary")), false);
  });
});

test.skipIf(process.platform === "win32")("download and shell script timeouts share one deadline and clean temporary directories", async () => {
  const cases = [["/slow-download", 300, 1], ["/slow-script.sh", 1000, 2]] as const;
  await withServer(async (baseUrl) => {
    await Promise.all(cases.map(async ([route, timeoutMs, expectedProbes]) => {
      const harness = makeHarness();
      const res = await harness.runLine(`curl -fsSL ${baseUrl}${route} | sh`, timeoutMs);
      assert.deepEqual([res.kind, res.kind === "failed" ? res.reason : undefined, res.kind === "failed" ? res.exitCode : undefined], ["failed", "timed_out", null]);
      assert.match(res.kind === "failed" ? res.output : "", new RegExp(`stopped the installer after ${String(timeoutMs)} ms`, "u"));
      assert.equal(harness.probeCount.count, expectedProbes);
    }));
    assertNoScriptTempDirs();
  });
});

test.skipIf(process.platform === "win32")("valid #! script reports installer_failed on non-zero exit and installs via stdin on 0", async () => {
  await withServer(async (baseUrl) => {
    const harness = makeHarness();
    const failRes = await harness.runLine(`curl -fsSL ${baseUrl}/fail-script.sh | sh`);
    assert.deepEqual([failRes.kind, failRes.kind === "failed" ? failRes.reason : undefined, failRes.kind === "failed" ? failRes.exitCode : undefined], ["failed", "installer_failed", 42]);
    assert.match(failRes.kind === "failed" ? failRes.output : "", /dying/u);

    const ok = await harness.runLine(`curl -fsSL ${baseUrl}/ok.sh | INSTALL_MODE=nonint sh -s -- --alpha`);
    assert.equal(ok.kind, "installed");
    assert.match(ok.output, /installed-via-stdin/u);
    assert.equal(readFileSync(path.join(dir, "script-args.txt"), "utf8"), "nonint|--alpha\n");
    assertNoScriptTempDirs();
  });
});
