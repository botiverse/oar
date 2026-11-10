import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

function manifest(name: string, parent: URL): string {
  const file = findPackageJSON(name, parent);
  assert.ok(file !== undefined, `Missing ${name}`);
  return realpathSync(file);
}

function metadata(file: string): { name: string; version: string } {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(typeof value === "object" && value !== null && "name" in value && "version" in value);
  assert.ok(typeof value.name === "string" && typeof value.version === "string");
  return { name: value.name, version: value.version };
}

/** Check the actual packed tree and exercise the SDK's OAuth loader after OAR's
 * registration. Synthetic unexpired credentials never reach a provider. */
function checkInstances(host: string): { sdkEntry: string; piAiVersion: string } {
  const entry = pathToFileURL(path.join(host, "probe.mjs"));
  const oar = pathToFileURL(manifest("@botiverse/oar", entry));
  const sdk = pathToFileURL(manifest("@earendil-works/pi-coding-agent", oar));
  for (const name of ["@earendil-works/pi-ai", "undici"]) {
    assert.equal(manifest(name, oar), manifest(name, sdk), `${name} split between OAR and the coding SDK`);
  }
  const installed = execFileSync("npm", ["ls", "@earendil-works/pi-ai", "--all", "--parseable"], { cwd: host, encoding: "utf8" });
  const { version } = metadata(manifest("@earendil-works/pi-ai", sdk));
  const copies = installed.trim().split(/\r?\n/u).map(directory => path.join(directory, "package.json"))
    .filter(file => metadata(file).name === "@earendil-works/pi-ai" && metadata(file).version === version);
  assert.equal(new Set(copies.map(file => realpathSync(file))).size, 1, `Multiple Pi AI ${version} copies in packed host`);
  return { sdkEntry: path.join(path.dirname(manifest("@earendil-works/pi-coding-agent", oar)), "dist/index.js"), piAiVersion: version };
}

/** Return the coding SDK's resolved Pi AI version for subsequent host peer installs. */
export async function checkPiHost(host: string): Promise<string> {
  const { sdkEntry, piAiVersion } = checkInstances(host);
  const directory = mkdtempSync(path.join(tmpdir(), "oar-pi-packed-auth-"));
  const contents = `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createPiProviderAuth } from "@botiverse/oar/runtimes/pi";
import { ModelRuntime } from ${JSON.stringify(sdkEntry)};
await createPiProviderAuth({ authPath: process.argv[2] + "/empty.json", modelsPath: null });
writeFileSync(process.argv[2] + "/auth.json", JSON.stringify({ anthropic: {
  type: "oauth", access: "OAR_SYNTHETIC_AUTH", refresh: "OAR_SYNTHETIC_REFRESH", expires: Date.now() + 86_400_000,
} }));
const runtime = await ModelRuntime.create({ authPath: process.argv[2] + "/auth.json", modelsPath: null,
  modelsStorePath: process.argv[2] + "/models-store.json", refreshOnCreate: false, allowModelNetwork: false });
const auth = await runtime.getAuth("anthropic", { env: {} });
assert.deepEqual(auth?.auth, { apiKey: "OAR_SYNTHETIC_AUTH" });
`;
  try {
    const outfile = path.join(directory, "host.mjs");
    await build({ stdin: { contents, resolveDir: host }, bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
      banner: { js: "import { createRequire as __oarHostRequire } from 'node:module'; const require = __oarHostRequire(import.meta.url);" } });
    execFileSync(process.execPath, [outfile, directory], { cwd: directory, stdio: "pipe",
      env: { ...process.env, OAR_PI_AGENT_DIR: directory, PI_CODING_AGENT_DIR: directory } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  return piAiVersion;
}

export const DURABLE_TYPES = `
import { createPiDurableRuntime } from "@botiverse/oar/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai-durable/models";
declare const harness: Harness;
const models = createModels();
export const direct = createPiDurableRuntime({ harness, models });
export const supplied = createPiDurableRuntime({ harness, models: () => models });
`;

export const DURABLE_PROBE = `
import assert from "node:assert/strict";
import { createPiDurableRuntime } from "@botiverse/oar/pi-durable";
import { promptAndWait } from "@botiverse/oar";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai-durable/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100 });
faux.setResponses([fauxAssistantMessage("DURABLE_PACKED_ANSWER")]);
models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
try {
  const runtime = createPiDurableRuntime({ harness, models });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/", model: "faux/faux-1" });
  try {
    assert.equal(session.status().value.kind, "idle");
    const turn = await promptAndWait(session, "packed host control", { timeoutMs: 30_000 });
    assert.equal(turn.kind, "ended");
    assert.deepEqual(turn.outcome, { kind: "completed" });
    const text = session.records().flatMap(record => record.kind === "frame" ? record.body.events : [])
      .filter(event => event.kind === "text_delta").map(event => event.text).join("");
    assert.equal(text, "DURABLE_PACKED_ANSWER");
  } finally { await session.dispose(); }
} finally { await harness.close(BACKGROUND_CONTEXT); }
`;
