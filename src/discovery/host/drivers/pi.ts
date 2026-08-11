/**
 * Pi-stack host runtime for oar — SDK (in-process) only for now.
 *
 * Product (xxchan 2026-08-10): first ship pi-sdk mode only; do not support pi-cli.
 * Naming (Huaihuai): registry id remains `pi` (no separate builtin row).
 *
 * Version (Huaihuai / HaoHao): real SDK package semver in the version slot.
 * Mode is never stuffed into `version`. Unresolvable package → `version: "unknown"`.
 *
 * Models: call the installed pi SDK in-process (`ModelRuntime.create`).
 * Catalog = getAvailableSnapshot() (auth-available only). No cross-repo shell-out.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { which } from "../probe.js";
import { emptyDeclaration, type RuntimeDriver } from "../../../backend/trait.js";
import type { IdleSession } from "../../../session/handle.js";
import type { ModelInfo, ProviderInfo } from "../../../config/model.js";
import { model } from "../../../config/model.js";

const PKG_JSON_CANDIDATES = [
  "@earendil-works/pi-coding-agent/package.json",
  "@mariozechner/pi-coding-agent/package.json",
] as const;

type PiSdkModel = {
  id: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
};

type PiModelRuntime = {
  getAvailableSnapshot: () => readonly PiSdkModel[];
  getModels: (providerId?: string) => readonly PiSdkModel[];
};

type PiSdkModule = {
  ModelRuntime: {
    create: (opts?: { allowModelNetwork?: boolean }) => Promise<PiModelRuntime>;
  };
};

/** Locate the installed pi-coding-agent package root (no CLI spawn). */
export function resolvePiSdkPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    for (const spec of PKG_JSON_CANDIDATES) {
      try {
        const p = require.resolve(spec);
        return dirname(p);
      } catch {
        // next
      }
    }
  } catch {
    // fall through
  }

  const bin = which("pi");
  if (!bin) return null;
  try {
    let dir = dirname(realpathSync(bin));
    for (let i = 0; i < 10; i++) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        const j = JSON.parse(readFileSync(pj, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (typeof j.name === "string" && /pi-coding-agent/i.test(j.name)) {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  return null;
}

export function resolvePiSdkVersion(): string | null {
  const root = resolvePiSdkPackageRoot();
  if (!root) return null;
  try {
    const j = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return typeof j.version === "string" && j.version.length > 0 ? j.version : null;
  } catch {
    return null;
  }
}

async function loadPiSdk(): Promise<{ root: string; mod: PiSdkModule } | null> {
  const root = resolvePiSdkPackageRoot();
  if (!root) return null;
  try {
    const entry = pathToFileURL(join(root, "dist", "index.js")).href;
    const mod = (await import(entry)) as PiSdkModule;
    if (!mod?.ModelRuntime?.create) return null;
    return { root, mod };
  } catch {
    return null;
  }
}

/**
 * Map SDK available models → provider axis.
 *
 * Sample (ModelRuntime.getAvailableSnapshot()):
 * ```json
 * [
 *   { "id": "glm-5.1", "name": "GLM-5.1", "provider": "zai", "reasoning": true },
 *   { "id": "glm-5.2", "name": "GLM-5.2", "provider": "zai", "reasoning": true }
 * ]
 * ```
 * Parsed → providers: [{ id:"zai", models:[{id:"glm-5.1",label:"GLM-5.1"}, ...] }]
 */
function toProviders(models: readonly PiSdkModel[]): readonly ProviderInfo[] {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const pid = m.provider?.trim() || "default";
    const list = byProvider.get(pid) ?? [];
    list.push(model(m.id, m.name ?? m.id, []));
    byProvider.set(pid, list);
  }
  return [...byProvider.entries()].map(([id, modelsForP]) => ({
    id,
    label: id,
    models: modelsForP,
  }));
}

/**
 * In-process session over a created `ModelRuntime`. pi has no child process, so
 * `stop()` is a plain teardown (nothing to kill) and there is no transport.
 *
 * ⚠️ HONEST GAP: the pi SDK's turn/event surface (how a prompt is submitted and
 * what event objects come back) is NOT documented anywhere in this repo — the
 * only pi SDK method used is `getAvailableSnapshot()` for the model catalog.
 * Wiring `prompt()` to real SDK events would mean GUESSING the turn API, which
 * the drive-layer discipline forbids. So `start()`/`create` is real, but the
 * turn (prompt → SDK events → normalise) is left explicitly unwired: `prompt()`
 * throws rather than fabricate a stream. codex is the fully-wired reference.
 */
function makePiSession(_rt: PiModelRuntime): IdleSession {
  return {
    state: "idle",
    capabilities: { steer: false, interrupt: false, resume: false, interceptToolCalls: false },
    async *events() {
      // No events until the SDK turn surface is wired (see makePiSession note).
    },
    async prompt(_text: string) {
      throw new Error(
        "pi: in-process turn/prompt API not wired — pi SDK turn surface is undocumented in this repo",
      );
    },
    async stop() {
      // In-process SDK: nothing to kill.
      return { state: "closed" as const };
    },
  };
}

export function piDriver(): RuntimeDriver {
  return {
    id: "pi",
    detect: async () => {
      const v = resolvePiSdkVersion();
      return { version: v ?? "unknown" };
    },
    // Prefer providers() when the provider axis is populated; flat list stays empty.
    models: async () => [],
    providers: async () => {
      const loaded = await loadPiSdk();
      if (!loaded) return [];
      try {
        // allowModelNetwork:false — pure local catalog, no network refresh on detect.
        const rt = await loaded.mod.ModelRuntime.create({ allowModelNetwork: false });
        const available = rt.getAvailableSnapshot();
        if (available.length === 0) return [];
        return toProviders(available);
      } catch {
        return [];
      }
    },
    describe: emptyDeclaration,
    normalise: () => [],
    // Direct construction: pi bypasses the subprocess mid-layer legitimately —
    // it is an in-process SDK, not a child. start() = ModelRuntime.create.
    start: async () => {
      const loaded = await loadPiSdk();
      if (!loaded) {
        throw new Error("pi: SDK not installed (ModelRuntime unavailable)");
      }
      const rt = await loaded.mod.ModelRuntime.create({ allowModelNetwork: true });
      return makePiSession(rt);
    },
  };
}
