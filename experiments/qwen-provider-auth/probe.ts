/* oxlint-disable typescript/promise-function-async -- Deadline callbacks forward the SDK promises. */
/* oxlint-disable no-await-in-loop -- Deliberately serial native observations avoid cold-start contention. */
/** Native Qwen provider metadata coverage, using isolated homes and synthetic keys. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const [cli, output, selected] = process.argv.slice(2);
assert.ok(cli !== undefined && cli.length > 0, "Pass the Qwen cli-entry.js path");
const root = path.resolve(output ?? "oar-trial-run/qwen-provider-auth");
const synthetic = "oar-synthetic-provider-key";
const settings = (value: JsonRecord): string => JSON.stringify({ $version: 4, ...value });
const cells: readonly { name: string; env?: Record<string, string>; files?: Record<string, string>; outside?: boolean }[] = [
  { name: "empty" },
  { name: "process-env", env: { DEEPSEEK_API_KEY: synthetic } },
  { name: "home-dotenv", files: { "home/.env": `DEEPSEEK_API_KEY=${synthetic}\n` } },
  { name: "user-settings-env", files: { "home/.qwen/settings.json": settings({ env: { DEEPSEEK_API_KEY: synthetic } }) } },
  { name: "system-settings-env", files: { "system.json": settings({ env: { DEEPSEEK_API_KEY: synthetic } }) } },
  { name: "workspace-settings-env", files: { "workspace/.qwen/settings.json": settings({ env: { DEEPSEEK_API_KEY: synthetic } }) } },
  { name: "workspace-settings-other-cwd", outside: true, files: { "workspace/.qwen/settings.json": settings({ env: { DEEPSEEK_API_KEY: synthetic } }) } },
  { name: "workspace-dotenv", files: { "workspace/.env": `DEEPSEEK_API_KEY=${synthetic}\n` } },
  { name: "user-auth-key", files: { "home/.qwen/settings.json": settings({ security: { auth: { selectedType: "openai", apiKey: synthetic } } }) } },
  { name: "models-no-key", files: { "home/.qwen/settings.json": settings({ modelProviders: { openai: [{ id: "deepseek-v4-pro", name: "[DeepSeek] deepseek-v4-pro", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY" }] } }) } },
];
const observed: JsonRecord[] = [];
for (const cell of cells.filter((entry) => selected === undefined || selected === entry.name)) {
  const directory = path.join(root, cell.name);
  const home = path.join(directory, "home");
  const cwd = path.join(directory, cell.outside === true ? "outside" : "workspace");
  await mkdir(path.join(home, ".qwen"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  for (const [file, content] of Object.entries(cell.files ?? {})) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, QWEN_HOME: path.join(home, ".qwen"),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(directory, "system.json"),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(directory, "defaults.json"),
    QWEN_CODE_TELEMETRY_ENABLED: "false", ...cell.env,
  };
  const child = startAcpProcess(process.execPath, [path.resolve(cli), "--acp"], createAcpClient({ name: "oar-provider-probe" }), { cwd, env, inheritStderr: false });
  try {
    const initialize = await withAcpDeadline(child, "initialize", 30_000, (options) => child.connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, options));
    const result = await withAcpDeadline(child, "qwen/providers/list", 30_000, (options) => child.connection.agent.request<JsonRecord>("qwen/providers/list", {}, options));
    assert.ok(!JSON.stringify(result).includes(synthetic), "native list must not return the synthetic key");
    const providers = asRecordList(result.providers);
    if (cell.name === "empty") { await writeFile(path.join(root, "providers.json"), JSON.stringify(providers, null, 2)); }
    const row = { name: cell.name, agent: asRecord(initialize)?.agentInfo, count: providers.length,
      configured: providers.filter((provider) => asRecord(provider.existingConfig) !== null).map((provider) => ({ id: provider.id, existingConfig: provider.existingConfig })),
    };
    observed.push(row);
    await writeFile(path.join(root, "observations.json"), JSON.stringify(observed, null, 2));
    console.log(JSON.stringify(row));
  } finally { child.kill(); await child.exited; }
}
