import type {
  InstallationSnapshot,
  ListModelsResult,
  Runtime,
} from "@botiverse/oar";

// Pure shape of one `oar models` row so the command action stays a thin
// print loop and the mapping from runtime capability + installation state
// to output can be pinned by tests without spawning anything.
export interface ModelsReport {
  readonly runtimeId: string;
  /** Present only when the runtime is installed but not `available`. */
  readonly installation?: InstallationSnapshot;
  /** `null` when installation state made listing impossible. */
  readonly models: ListModelsResult | null;
}

export async function readModels(
  runtime: Runtime,
  options?: { readonly timeoutMs?: number },
): Promise<ModelsReport> {
  if (runtime.listModels === undefined || runtime.installation === undefined) {
    return {
      runtimeId: runtime.id,
      models: {
        kind: "unsupported",
        reason: runtime.listModels === undefined
          ? `${runtime.id} exposes no listModels capability`
          : `${runtime.id} exposes no installation probe`,
      },
    };
  }
  const installation = await runtime.installation();
  if (installation.kind !== "available") {
    return { runtimeId: runtime.id, installation, models: null };
  }
  return {
    runtimeId: runtime.id,
    models: await runtime.listModels(installation, options),
  };
}

// Human table for one report: one line per model, or one line stating why
// there is no list. `id` is the selector to pass to `oar run --model`.
export function renderModels(report: ModelsReport): string[] {
  const { runtimeId, models } = report;
  if (models === null) {
    return [`${runtimeId}: not available (${report.installation?.kind ?? "unknown"})`];
  }
  if (models.kind === "unauthenticated") {
    return [`${runtimeId}: not logged in${models.detail === undefined ? "" : ` (${models.detail})`}`];
  }
  if (models.kind === "unsupported") {
    return [`${runtimeId}: unsupported (${models.reason})`];
  }
  if (models.models.length === 0) {
    return [`${runtimeId}: no models`];
  }
  return models.models.map((model) => {
    const parts = [`${runtimeId}\t${model.id}`];
    if (model.resolvedId !== undefined && model.resolvedId !== model.id) {
      parts.push(`-> ${model.resolvedId}`);
    }
    if (model.displayName !== undefined && model.displayName !== model.id) {
      parts.push(`"${model.displayName}"`);
    }
    if (model.effortLevels !== undefined && model.effortLevels.length > 0) {
      const marked = model.effortLevels.map((level) =>
        level === model.defaultEffort ? `${level}*` : level);
      parts.push(`[${marked.join(",")}]`);
    }
    if (model.disabled !== undefined) {
      parts.push(`(disabled: ${model.disabled.reason})`);
    }
    return parts.join(" ");
  });
}
