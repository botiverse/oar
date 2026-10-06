import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { runExecutable } from "../../shared/executable/index.js";
import { processFailure, stderrTail } from "../../shared/executable/diagnostics.js";
import { asRecord, parseJson } from "../../shared/json.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project `opencode models --verbose` (1.18.30, cli/cmd/models.ts): for each
 * model of every configured provider, a `provider/model` line, then the
 * model as indented JSON closed by a `}` line. The `provider/model` line is
 * the id `opencode acp` offers in its `model` config option. The model's
 * `variants` keys are the values of its `effort` (`thought_level`) option,
 * which `SessionOptions.effort` sets (later builds add a `default` value
 * there, meaning no variant, which is not a level). No `defaultEffort`: which
 * variant a new session starts on is the session's to report.
 */
export function projectOpencodeModels(stdout: string): ModelEntry[] {
  const lines = stdout.split(/\r?\n/u);
  const entries: ModelEntry[] = [];
  let index = 0;
  while (index < lines.length) {
    const id = /^(\S+\/\S+)$/u.exec(lines[index] ?? "")?.[1];
    index += 1;
    if (id === undefined || lines[index] !== "{") {
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? "";
      body.push(line);
      index += 1;
      if (line === "}") {
        break;
      }
    }
    const model = asRecord(parseJson(body.join("\n")));
    const displayName = text(model?.name);
    const effortLevels = Object.keys(asRecord(model?.variants) ?? {});
    entries.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(effortLevels.length === 0 ? {} : { effortLevels }),
    });
  }
  return entries;
}

/** Reads opencode's model catalog; the first run after an install also fetches models.dev. */
export const opencodeListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "opencode model listing requires the opencode executable" };
  }
  const result = await runExecutable(installation.command, ["models", "--verbose"], { timeoutMs: options.timeoutMs ?? 30_000 });
  if (!result.ok) {
    throw processFailure("Failed to list opencode models", result.diagnostics ?? {
      exitCode: result.exitCode, signal: null, stderr: stderrTail(result.stderr),
    });
  }
  return { kind: "ok", models: projectOpencodeModels(result.stdout) };
};
