/**
 * Pi-stack host runtime for oar — SDK (in-process) only for now.
 *
 * Product (xxchan 2026-08-10): first ship pi-sdk mode only; do not support pi-cli.
 * Naming (Huaihuai): registry id remains `pi` (no separate builtin row).
 *
 * Version (Huaihuai / HaoHao): real SDK package semver in the version slot.
 * Mode is never stuffed into `version`. Unresolvable package → the runtime is
 * ABSENT (detect returns null); it is NOT reported present with a placeholder
 * version. `pi` present means the SDK is there and in-process drivable, which
 * is what the Raft adapter synthesises `builtin` from.
 *
 * Models: call the installed pi SDK in-process (`ModelRuntime.create`).
 * Catalog = getAvailableSnapshot() (auth-available only). No cross-repo shell-out.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSdkPackage } from "../sdkResolve.js";
import { emptyDeclaration, type RuntimeDriver } from "../../../backend/trait.js";
import type { IdleSession } from "../../../session/handle.js";
import type { ModelInfo, ProviderInfo } from "../../../config/model.js";
import { model } from "../../../config/model.js";
import {
  PI_SDK_CANDIDATES,
  resolvePiSdkPackageRoot,
  resolvePiSdkVersion,
} from "../piResolve.js";

export {
  resolvePiSdkPackageRoot,
  resolvePiSdkVersion,
} from "../piResolve.js";

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

async function loadPiSdk(): Promise<{ root: string; mod: PiSdkModule } | null> {
  // Prefer the entry the package itself declares. Guessing `dist/index.js` is
  // the same class of assumption as the package.json subpath: it happens to be
  // true today and breaks silently when the package restructures.
  const resolved = resolveSdkPackage(PI_SDK_CANDIDATES);
  const candidates: string[] = [];
  if (resolved) candidates.push(resolved.entry);
  const root = resolved?.root ?? resolvePiSdkPackageRoot();
  if (!root) return null;
  candidates.push(join(root, "dist", "index.js"));

  for (const entryPath of candidates) {
    try {
      const mod = (await import(pathToFileURL(entryPath).href)) as PiSdkModule;
      // typeof, not truthiness: the cast asserts `create` exists, so a plain
      // truthy test is statically always-true (TS2774) and would silently stop
      // guarding the case this loop is FOR — an entry that imported fine but is
      // not the SDK shape.
      if (typeof mod?.ModelRuntime?.create === "function") return { root, mod };
    } catch {
      // next candidate
    }
  }
  return null;
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

/**
 * Injectable SDK-version probe. Production passes nothing; the identity teeth
 * pass a fake so SDK-only / CLI-only / neither can be asserted without a real
 * install and without touching PATH.
 */
export interface PiProbes {
  readonly sdkVersion: () => string | null;
}

export function piDriver(probes?: Partial<PiProbes>): RuntimeDriver {
  const sdkVersion = probes?.sdkVersion ?? resolvePiSdkVersion;
  return {
    id: "pi",
    detect: async () => {
      // ⛔ Do not restore `?? "unknown"`. Returning a descriptor for an
      // unresolvable SDK made `pi` permanently present: detect.ts treats null as
      // the ONLY expression of absent, so "unknown" reports a runtime that is not
      // there — and the Raft adapter would synthesise `builtin` from it.
      const version = sdkVersion();
      return version === null ? null : { version };
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
