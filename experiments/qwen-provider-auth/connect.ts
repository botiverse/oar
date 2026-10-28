/* oxlint-disable typescript/promise-function-async -- Deadline callbacks forward the SDK promises. */
/* oxlint-disable no-await-in-loop -- Reconnect observes the preceding native write; scopes are run serially. */
/** Native provider setup with synthetic credentials and a loopback endpoint. */
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const [cli, output] = process.argv.slice(2);
assert.ok(cli !== undefined && cli.length > 0, "Pass the Qwen cli-entry.js path");
const root = path.resolve(output ?? "oar-trial-run/qwen-provider-connect");
const synthetic = "oar-synthetic-connect-key";
let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "synthetic unauthorized", type: "authentication_error" } }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const rows: JsonRecord[] = [];
async function settingsAt(file: string): Promise<JsonRecord> {
  try { return asRecord(JSON.parse(await readFile(file, "utf8"))) ?? {}; }
  catch (error) { if (asRecord(error)?.code === "ENOENT") { return {}; } throw error; }
}
try {
  for (const cell of ["user", "workspace", "omitted", "persist-failure"]) {
    let scope: string | undefined = cell;
    if (cell === "omitted") { scope = undefined; }
    if (cell === "persist-failure") { scope = "user"; }
    const directory = path.join(root, cell);
    const home = path.join(directory, "home");
    const cwd = path.join(directory, "workspace");
    await mkdir(path.join(home, ".qwen"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const child = startAcpProcess(process.execPath, [path.resolve(cli), "--acp"], createAcpClient({ name: "oar-provider-connect-probe" }), {
      cwd, inheritStderr: false, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, QWEN_HOME: path.join(home, ".qwen"),
        QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(directory, "system.json"), QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(directory, "defaults.json"), QWEN_CODE_TELEMETRY_ENABLED: "false" },
      redact: (text) => text.replaceAll(synthetic, "[redacted]"),
    });
    try {
      await withAcpDeadline(child, "initialize", 30_000, (options) => child.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }, options));
      if (cell === "persist-failure") {
        await rm(path.join(home, ".qwen/settings.json"), { force: true });
        await mkdir(path.join(home, ".qwen/settings.json"));
      }
      const params = { providerId: "custom-openai-compatible", apiKey: synthetic, baseUrl, protocol: "openai", wireApi: "chat-completions", modelIds: ["oar-fixture-model"], ...(scope === undefined ? {} : { scope }) };
      for (const [name, input] of [
        ["connect", params],
        ["reuse-key", { ...params, apiKey: undefined }],
        ["unknown-provider", { ...params, providerId: `missing-${synthetic}` }],
        ["invalid-scope", { ...params, scope: "system" }],
      ] as const) {
        // oxlint-disable-next-line max-depth -- Each request records either native success or native failure.
        try {
          const result = await withAcpDeadline(child, "qwen/providers/connect", 30_000, (options) => child.connection.agent.request<JsonRecord>("qwen/providers/connect", input, options));
          assert.ok(!JSON.stringify(result).includes(synthetic));
          rows.push({ scope: cell, name, result });
        } catch (error) {
          const record = asRecord(error);
          rows.push({ scope: cell, name, error: { name: error instanceof Error ? error.name : "unknown", code: record?.code, data: record?.data, message: error instanceof Error ? error.message : "unknown" } });
        }
      }
      const listed = await withAcpDeadline(child, "qwen/providers/list", 30_000, (options) => child.connection.agent.request<JsonRecord>("qwen/providers/list", {}, options));
      if (cell !== "persist-failure") {
        const user = await settingsAt(path.join(home, ".qwen/settings.json"));
        const workspace = await settingsAt(path.join(cwd, ".qwen/settings.json"));
        rows.push({ scope: cell, name: "persisted", userKey: Object.values(asRecord(user.env) ?? {}).includes(synthetic), workspaceKey: Object.values(asRecord(workspace.env) ?? {}).includes(synthetic),
          existingConfig: asRecordList(listed.providers).find((provider) => provider.id === "custom-openai-compatible")?.existingConfig,
        });
      }
      assert.ok(!JSON.stringify(rows).includes(synthetic));
      await writeFile(path.join(root, "observations.json"), JSON.stringify({ requests, rows }, null, 2));
    } finally { child.kill(); await child.exited; }
  }
  console.log(JSON.stringify({ requests, rows }, null, 2));
} finally { server.closeAllConnections(); server.close(); }
