/* oxlint-disable eslint/max-statements -- End-to-end child-process harness exercises inherited env and daemon handshake redaction across session and model listing. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { qoderListModels } from "../../packages/oar/src/runtimes/qoder/list-models.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

afterEach(() => { vi.unstubAllEnvs(); });

function writeFakeQoder(dir: string, handshakeSecret: string, failModels = false): string {
  const script = path.join(dir, "fake-qoder.mjs");
  writeFileSync(script, `
    import { createInterface } from "node:readline";
    if (process.argv[2] === "status") {
      process.stdout.write(JSON.stringify({ logged_in: true }) + "\\n");
      process.exit(0);
    }
    const secret = process.env.QODER_PERSONAL_ACCESS_TOKEN ?? process.env.QODER_SERVICE_ACCOUNT_KEY ?? "";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      const req = msg.request ?? {};
      if (req.type === "daemon.initialize") {
        process.stdout.write(JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: msg.request_id, response: { daemon_protocol_version: 2, capabilities: ["multi_session_v2", "daemon_queries_v1"], sessionToken: ${JSON.stringify(handshakeSecret)} } }
        }) + "\\n");
      } else if (req.type === "daemon.open_session") {
        const sid = req.worker_args.find(a => a.startsWith("--session-id=")).slice("--session-id=".length);
        process.stdout.write(JSON.stringify({ type: "control_response", session_id: sid, response: { subtype: "success", request_id: msg.request_id, response: {} } }) + "\\n");
      } else if (req.subtype === "initialize") {
        process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: msg.session_id, model: "efficient" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "control_response", session_id: msg.session_id, response: { subtype: "success", request_id: msg.request_id, response: {} } }) + "\\n");
      } else if (req.subtype === "get_settings") {
        process.stdout.write(JSON.stringify({ type: "control_response", session_id: msg.session_id, response: { subtype: "success", request_id: msg.request_id, response: { applied: {} } } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "daemon.notice", detail: "leaked " + secret + " and " + ${JSON.stringify(handshakeSecret)} }) + "\\n");
      } else if (req.type === "daemon.get_models") {
        if (${String(failModels)}) {
          process.stderr.write("fatal auth " + secret + " " + ${JSON.stringify(handshakeSecret)} + "\\n");
          process.exit(1);
        }
        process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { models: [] } } }) + "\\n");
      }
    });
  `);
  return fakeAgentBinary(dir, [script]);
}

test.each(["QODER_PERSONAL_ACCESS_TOKEN", "QODER_SERVICE_ACCOUNT_KEY"] as const)("inherited %s and daemon handshake secrets are redacted in Qoder records and model-listing errors", async (envName) => {
  const inheritedSecret = "qoder-inherited-credential-sentinel-987654";
  const handshakeSecret = "qoder-daemon-handshake-token-654321";
  vi.stubEnv(envName, inheritedSecret);
  const dir = mkdtempSync(path.join(tmpdir(), "oar-qoder-cred-"));
  try {
    const command = writeFakeQoder(dir, handshakeSecret, true);
    const installation = { kind: "available", via: "executable", command, version: "1.1.81" } as const;
    const session = await qoderSession(installation, { cwd: dir });
    try {
      const records = JSON.stringify(session.records());
      expect(records).toContain("[redacted]");
      expect(records).not.toContain(inheritedSecret);
      expect(records).not.toContain(handshakeSecret);
    } finally { await session.dispose(); }
    const failure: unknown = await qoderListModels(installation, { cwd: dir }).catch((error: unknown) => error);
    const text = inspect(failure, { depth: 20, showHidden: true });
    expect(text).not.toContain(inheritedSecret);
    expect(text).not.toContain(handshakeSecret);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
