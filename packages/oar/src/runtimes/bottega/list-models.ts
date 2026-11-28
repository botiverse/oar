import type { ListModelsResult, ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { assertRan } from "../../shared/executable/diagnostics.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, asRecordList, parseJson } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { bottegaCommand } from "./launch.js";

const LIST_TIMEOUT_MS = 30_000;

/**
 * `bottega models --json`, as `Session.model` selectors. bottega opens a
 * session on a provider and that provider's model id, so the selector is
 * `provider/model`, the spelling `open` takes back (`options.ts`). `thinking`
 * is pi's reasoning menu for the model in bottega's spelling; a model
 * without reasoning takes `off` alone and lists no menu.
 */
export function projectBottegaModels(listing: unknown): readonly ModelEntry[] {
  return asRecordList(asRecord(listing)?.models).flatMap((model): ModelEntry[] => {
    if (typeof model.provider !== "string" || typeof model.id !== "string") { return []; }
    const thinking = Array.isArray(model.thinking) ? model.thinking.filter((level): level is string => typeof level === "string") : [];
    return [{
      id: `${model.provider}/${model.id}`,
      displayName: typeof model.name === "string" && model.name.trim().length > 0 ? model.name.trim() : model.id,
      provider: { id: model.provider, ...(typeof model.providerName === "string" ? { displayName: model.providerName } : {}) },
      ...(thinking.length > 1 ? { effortLevels: thinking } : {}),
      ...(model.default === true ? { default: true as const } : {}),
    }];
  });
}

/**
 * bottega's own list of what a session can open on now: providers with a key
 * in the environment or bottega's key file, or a login it reads. `--stale`
 * reads the provider catalogs bottega keeps on disk, as a session does,
 * instead of asking each provider first. bottega always has a catalog, so a
 * list with nothing in it means no provider has credentials.
 */
export const bottegaListModels: ModelLister = async (installation, options = {}): Promise<ListModelsResult> => {
  const { command, args } = bottegaCommand(installation, ["models", "--json", "--stale"]);
  const cwd = listingCwd(options);
  const timeoutMs = options.timeoutMs ?? LIST_TIMEOUT_MS;
  const credentials = sessionCredentialRedactor({ cwd, ...(options.env === undefined ? {} : { env: options.env }) });
  try {
    return await withQueryDeadline<ListModelsResult>("Bottega model listing", timeoutMs, async (signal) => {
      const result = await runExecutable(command, args, {
        cwd, env: sessionEnvironment(options.env), timeoutMs, signal,
      });
      assertRan(result, "Failed to list bottega models");
      if (!result.ok) {
        const said = credentials.redact(result.stderr.trim().split("\n").at(-1) ?? "");
        return { kind: "unsupported", reason: `bottega models --json failed${result.exitCode === null ? "" : ` (${String(result.exitCode)})`}${said.length > 0 ? `: ${said}` : ""}` };
      }
      const listing = parseJson(result.stdout.trim());
      if (asRecord(listing) === null || !Array.isArray(asRecord(listing)?.models)) {
        return { kind: "unsupported", reason: "bottega models --json printed no model list" };
      }
      const models = projectBottegaModels(listing);
      return models.length === 0
        ? { kind: "unauthenticated", detail: "No bottega provider has credentials: set a provider's API key (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ...) or add one with bottega's key file." }
        : { kind: "ok", models };
    });
  } catch (error) {
    throw credentials.redactValue(error);
  }
};
