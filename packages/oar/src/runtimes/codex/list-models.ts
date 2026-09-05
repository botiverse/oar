import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelOf, effortLevelsOf } from "../../shared/effort-levels.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";

function displayName(model: JsonRecord): string | undefined {
  const name = model.display_name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

/**
 * Project `codex debug models` output. Identity is `slug`; `display_name` is
 * presentation only (the same slug has rendered under unrelated names).
 * Entries with `visibility: "hide"` are present in the payload but codex will
 * not offer them, so they are dropped to keep usable-now semantics.
 * `supported_reasoning_levels` entries are `{effort, description}` objects.
 */
export function projectCodexModels(payload: unknown): ModelEntry[] {
  const models = asRecordList(asRecord(payload)?.models);
  const entries: ModelEntry[] = [];
  for (const model of models) {
    if (typeof model.slug !== "string" || model.slug.length === 0 || model.visibility === "hide") {
      continue;
    }
    const name = displayName(model);
    const effortLevels = effortLevelsOf(model.supported_reasoning_levels);
    const defaultEffort = effortLevelOf(model.default_reasoning_level);
    entries.push({
      id: model.slug,
      ...(name === undefined ? {} : { displayName: name }),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    });
  }
  return entries;
}

/**
 * Codex prints the whole list as one JSON document on stdout, close to 2 MB
 * because every model embeds its instruction templates. That is too close to
 * `runExecutable`'s buffer cap, so stdout is streamed and parsed on exit.
 */
async function readModelsJson(command: string, timeoutMs: number): Promise<string> {
  const child = spawnLineProcess(command, ["debug", "models"], { env: process.env });
  let text = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    text += chunk.toString();
  });
  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);
  try {
    await child.spawned;
    const code = await child.exited;
    if (code !== 0) {
      throw new Error(`codex debug models exited with ${code === null ? "a signal" : `code ${code}`}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Codex has no observable logged-out state on this surface: with no
 * credentials it still exits 0 and prints its built-in fallback list, so this
 * lister never returns `unauthenticated`. A non-zero exit, a timeout, or
 * non-JSON output is an error, not an empty list.
 */
async function readModelsText(command: string, timeoutMs: number): Promise<string> {
  try {
    return await readModelsJson(command, timeoutMs);
  } catch (error) {
    throw new Error("Failed to list Codex models", { cause: error });
  }
}

export const codexListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "codex model listing requires the codex executable" };
  }
  const text = await readModelsText(installation.command, options.timeoutMs ?? 15_000);
  const payload = parseJson(text);
  if (payload === undefined) {
    throw new Error("Failed to list Codex models: codex debug models returned invalid JSON");
  }
  return { kind: "ok", models: projectCodexModels(payload) };
};
