import { baseDriver, which, runText, modelsOnly } from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";

/**
 * Parse `opencode models` stdout (one provider/model id per line).
 *
 * Fixture: fixtures/opencode-models.sample.txt
 * Sample may include node warning noise before the id list — keep full text.
 * Parsed → ids containing `/`; drop Warning/stack lines.
 */
export function parseOpencodeModelsOutput(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes("/") && !l.includes("Warning") && !l.includes(" at "));
}

export function opencodeDriver(): RuntimeDriver {
  return baseDriver("opencode", {
    detect: async () => {
      const path = which("opencode");
      if (!path) return null;
      const r = runText(path, ["--version"], { timeoutMs: 15_000 });
      const lines = (r.stdout + "\n" + r.stderr)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const ver = lines.find((l) => /^\d+\.\d+/.test(l)) ?? lines.at(-1);
      return ver ? { version: ver } : { version: "opencode" };
    },
    models: async () => {
      const path = which("opencode");
      if (!path) return [];
      const r = runText(path, ["models"], { timeoutMs: 30_000 });
      const ids = parseOpencodeModelsOutput(r.stdout + "\n" + r.stderr);
      return modelsOnly(ids.map((id) => ({ id, label: id })));
    },
  });
}
