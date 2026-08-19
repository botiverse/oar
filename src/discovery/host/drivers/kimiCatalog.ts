import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kimiCodeHome } from "../runtimePaths.js";
import {
  fileExists,
  ModelsProbeError,
  type LiveModel,
} from "../runtimeProbe.js";

/** Pure parse of kimi-code config.toml — unit-tested without the filesystem. */
export function parseKimiCodeConfigToml(raw: string): {
  models: LiveModel[];
  defaultModel?: string;
} {
  const models: LiveModel[] = [];
  const sectionRe = /^\s*\[models\.(.+?)\s*\]\s*$/gm;
  let sectionMatch: RegExpExecArray | null = sectionRe.exec(raw);
  while (sectionMatch !== null) {
    let id = sectionMatch[1]!.trim();
    if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
    if (!id) {
      sectionMatch = sectionRe.exec(raw);
      continue;
    }

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const nextSection = raw.slice(sectionStart).search(/^\s*\[/m);
    const body =
      nextSection === -1
        ? raw.slice(sectionStart)
        : raw.slice(sectionStart, sectionStart + nextSection);
    const displayMatch = body.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
    const label = displayMatch ? displayMatch[1]! : id;

    const effortsMatch = body.match(/^\s*support_efforts\s*=\s*\[([^\]]*)\]/m);
    const supportedReasoningEfforts: string[] | undefined = effortsMatch
      ? [...effortsMatch[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
      : undefined;

    const entry: LiveModel = { id, label };
    if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
      entry.supportedReasoningEfforts = supportedReasoningEfforts;
    }
    models.push(entry);
    sectionMatch = sectionRe.exec(raw);
  }

  const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  const defaultModel: string | undefined = defaultMatch ? defaultMatch[1] : undefined;

  return { models, ...(defaultModel !== undefined ? { defaultModel } : {}) };
}

/** Shared config.toml catalog read — identical for both Kimi identities. */
export function readKimiModels(): readonly LiveModel[] {
  const configPath = join(kimiCodeHome(), "config.toml");
  if (!fileExists(configPath)) {
    throw new ModelsProbeError(
      "needs_login",
      "kimi config.toml missing (run kimi login / set KIMI_CODE_HOME)",
    );
  }
  let raw = "";
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new ModelsProbeError("models_unavailable", "kimi config.toml unreadable");
  }
  const { models } = parseKimiCodeConfigToml(raw);
  if (models.length === 0) {
    throw new ModelsProbeError(
      "needs_login",
      "kimi config.toml has no [models.*] sections",
    );
  }
  return models;
}
