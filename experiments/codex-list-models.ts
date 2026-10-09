/**
 * Compare OAR's app-server model/list picker with the former debug models
 * surface under the SAME home, environment and executable. Lists metadata
 * only: no model prompts, login changes, or account identifiers in output.
 *
 * Run: OAR_CODEX_BIN=/path/to/codex pnpm tsx experiments/codex-list-models.ts
 * For the logged-out case, run in an empty working directory with CODEX_HOME
 * pointing at a fresh directory and no OPENAI_API_KEY or CODEX_API_KEY.
 * model/list runs first, before debug models can populate the model cache.
 *
 * Observations and limits: service-tier-2026-10-08.md.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { codexListModels } from "../packages/oar/src/runtimes/codex/list-models.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord, asRecordList } from "../packages/oar/src/shared/json.js";

/** Only login presence, never the account payload (which can identify its owner). */
async function accountPresent(command: string): Promise<boolean> {
  const client = startAppServerClient(command);
  const timer = setTimeout(() => { client.kill(); }, 15_000);
  try {
    await client.spawned;
    client.handle({ onNotification: () => {}, onServerRequest: () => {} });
    await client.request("initialize", { clientInfo: { name: "oar-model-comparison", version: "0" } });
    client.notify("initialized", {});
    const reply = await client.request("account/read", { refreshToken: false });
    assert.ok("account" in reply, "account/read did not report account presence");
    return reply.account !== null;
  } finally {
    clearTimeout(timer);
    client.kill();
    await client.exited;
  }
}

function debugModelIds(command: string): readonly string[] {
  const stdout = execFileSync(command, ["debug", "models"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed: unknown = JSON.parse(stdout);
  const models = asRecord(parsed)?.models;
  assert.ok(Array.isArray(models), "debug models did not return a models array");
  return asRecordList(models).flatMap((model) =>
    typeof model.slug === "string" && model.slug.length > 0 && model.visibility !== "hide" ? [model.slug] : []);
}

const command = process.env.OAR_CODEX_BIN ?? "codex";
const version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
const listing = await codexListModels({ kind: "available", via: "executable", command });
const authenticated = await accountPresent(command);
const debugIds = debugModelIds(command);
const pickerIds = listing.kind === "ok" ? listing.models.map((model) => model.id) : [];
process.stdout.write(`${JSON.stringify({
  version,
  authenticated,
  listingKind: listing.kind,
  debugIds,
  pickerIds,
  onlyDebug: debugIds.filter((id) => !pickerIds.includes(id)),
  onlyPicker: pickerIds.filter((id) => !debugIds.includes(id)),
  serviceTiers: listing.kind === "ok" ? listing.models.map(({ id, serviceTiers }) => ({ id, serviceTiers })) : [],
}, null, 2)}\n`);
