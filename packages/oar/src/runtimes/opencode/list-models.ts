import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { runExecutable } from "../../shared/executable/index.js";
import { processFailure, stderrTail } from "../../shared/executable/diagnostics.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { opencodeMajor } from "./version.js";

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
  const major = await opencodeMajor(installation);
  // v2's default command connects to a persistent daemon. Listing must not leave one behind.
  const result = await runExecutable(installation.command, ["models", major === 2 ? "--standalone" : "--verbose"], { timeoutMs: options.timeoutMs ?? 30_000 });
  if (!result.ok) {
    throw processFailure("Failed to list opencode models", result.diagnostics ?? {
      exitCode: result.exitCode, signal: null, stderr: stderrTail(result.stderr),
    });
  }
  if (major === 1) { return { kind: "ok", models: projectOpencodeModels(result.stdout) }; }
  const ids = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { kind: "unsupported", reason: "opencode 2.0.26 models --standalone exits before the cold catalog finishes loading; an empty response does not establish that no models exist (https://github.com/anomalyco/opencode/issues/53724)" };
  }
  if (ids.some((id) => !/^\S+\/\S+$/u.test(id))) {
    throw new Error("opencode models --standalone returned an unrecognized model listing");
  }
  return { kind: "ok", models: ids.map((id) => ({ id })) };
};
