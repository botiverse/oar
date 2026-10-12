import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { startAppServerClient } from "./app-server-client.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** `model/list` is the native picker, including service tiers; `debug models` is not. */
export function projectCodexModels(payload: unknown): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const model of asRecordList(asRecord(payload)?.data)) {
    const id = text(model.model);
    if (id === undefined || model.hidden === true) { continue; }
    const displayName = text(model.displayName);
    const effortLevels = effortLevelsOf(Array.isArray(model.supportedReasoningEfforts) ? asRecordList(model.supportedReasoningEfforts).map((level) => level.reasoningEffort) : undefined);
    const defaultEffort = text(model.defaultReasoningEffort);
    // Keep native ids verbatim, never rename priority to the CLI's fast alias.
    const serviceTiers = Array.isArray(model.serviceTiers)
      ? [...new Set(asRecordList(model.serviceTiers).flatMap((tier) => text(tier.id) ?? []))]
      : undefined;
    const defaultServiceTier = text(model.defaultServiceTier);
    entries.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(serviceTiers === undefined ? {} : { serviceTiers }),
      ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
      ...(model.isDefault === true ? { default: true as const } : {}),
    });
  }
  return entries;
}

/**
 * The model a session with no `model` runs on (#347): the one codex's own
 * configuration sets (`config/read`, user and project config for the host's
 * cwd) when it is listed, else the catalog's `isDefault`. A configured model
 * that is not listed marks nothing.
 */
export function codexDefaultModel(models: readonly ModelEntry[], configured: string | undefined): ModelEntry[] {
  if (configured === undefined) {
    return [...models];
  }
  const listed = models.some((model) => model.id === configured);
  return models.map((model) => {
    const { default: _catalog, ...rest } = model;
    return listed && model.id === configured ? { ...rest, default: true as const } : rest;
  });
}

export const codexListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "codex model listing requires the codex executable" };
  }
  const client = startAppServerClient(installation.command);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = { timedOut: false };
  const timer = setTimeout(() => { deadline.timedOut = true; client.kill(); }, timeoutMs);
  try {
    await client.spawned;
    client.handle({ onNotification: () => {}, onServerRequest: () => {} });
    await client.request("initialize", { clientInfo: { name: "oar-models", version: "0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const models: ModelEntry[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await client.request("model/list", cursor === null ? {} : { cursor });
      if (!Array.isArray(page.data)) { throw new TypeError("codex model/list returned no data array"); }
      models.push(...projectCodexModels(page));
      cursor = text(page.nextCursor) ?? null;
      if (cursor !== null && cursors.has(cursor)) { throw new Error("codex model/list repeated a pagination cursor"); }
      if (cursor !== null) { cursors.add(cursor); }
    } while (cursor !== null);
    const effective = await client.request("config/read", { cwd: process.cwd(), includeLayers: false });
    return { kind: "ok", models: codexDefaultModel(models, text(asRecord(effective.config)?.model)) };
  } catch (error) {
    throw new Error(deadline.timedOut ? `Failed to list Codex models: timed out after ${String(timeoutMs)} ms` : "Failed to list Codex models", { cause: error });
  } finally {
    clearTimeout(timer);
    client.kill();
    await client.exited;
  }
};
