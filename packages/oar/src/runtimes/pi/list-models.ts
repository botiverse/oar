import type { ModelLister } from "../../contracts/list-models.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { checkPiProjectPackages, reportMissingPiPackages } from "./project.js";
import type { PiProjectOptions } from "./options.js";
import { preparePi } from "./static-modules.js";
import { piAgentDir } from "./resolve.js";

import { projectPiModels, type PiListedModel, type PiAvailabilitySource, type PiThinkingLevelsOf } from "./model-projection.js";

export { projectPiModels } from "./model-projection.js";
/**
 * In-process through the bundled SDK, built the way `pi --list-models` builds
 * its own runtime: `createAgentSessionServices` loads the extensions under the
 * agent dir and applies their provider registrations to the ModelRuntime
 * before anything is listed. That matters because extensions can be the ONLY
 * source of providers (on exe.dev every listed provider comes from the exe-dev
 * extension; auth.json is empty). A bare `ModelRuntime.create()` sees none of
 * them and prints "no models" while `pi --list-models` prints dozens.
 *
 * The list itself comes from `getAvailable()`, which computes availability on
 * demand. Do NOT read `ModelRegistry.getAvailable()` / `getAvailableSnapshot()`
 * here: that snapshot starts empty and is only filled by an availability
 * refresh (the other half of the 2026-09-05 "no models" bug).
 *
 * It is built for the listing's cwd, as a session there would be: the
 * project's settings can save another default, and its extensions (under
 * `.pi/extensions`) load and run like the agent dir's. Skills, prompt
 * templates, themes, and context files are skipped: they cannot register
 * providers, and listing must not read the project's prompt files.
 * `OAR_PI_AGENT_DIR` pins the agent dir exactly as the session adapter does,
 * so the list and the session see the same providers.
 *
 * Pi keys on provider API keys rather than one login, so "nothing configured"
 * is an `ok` empty list, not `unauthenticated`.
 */
export function createPiListModels<Model extends PiListedModel>(
  createRuntime: (signal: AbortSignal, cwd: string) => Promise<PiAvailabilitySource<Model>>,
  thinkingLevelsOf?: () => Promise<PiThinkingLevelsOf<Model>>,
): ModelLister {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "pi model listing runs through the bundled Pi SDK" };
    }
    try {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const runtime = await createRuntime(signal, listingCwd(options));
      const available = await runtime.getAvailable(undefined, { signal });
      const context = {
        providerName: (providerId: string): string | undefined => runtime.getProvider?.(providerId)?.name,
        ...(runtime.savedDefault === undefined ? {} : { savedDefault: runtime.savedDefault }),
      };
      return { kind: "ok", models: projectPiModels(available, await thinkingLevelsOf?.(), context) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unsupported", reason: `pi SDK could not list available models: ${detail}` };
    }
  };
}

export const piModelLister = (project: PiProjectOptions = {}): ModelLister => createPiListModels(async (signal, cwd) => {
  const { createAgentSessionServices, getAgentDir, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const agentDir = piAgentDir(getAgentDir);
  // getAvailable() can refresh OAuth tokens over the network: the proxy
  // plane first, from the same settings manager the services get (see
  // http.ts).
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: project.projectTrusted ?? true });
  await checkPiProjectPackages(cwd, agentDir, settingsManager, project);
  await reportMissingPiPackages(cwd, agentDir, settingsManager);
  await preparePi(settingsManager);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntimeSignal: signal,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const modelRuntime = services.modelRuntime;
  const provider = settingsManager.getDefaultProvider();
  const id = settingsManager.getDefaultModel();
  return {
    getAvailable: async (providerId, options) => { const models = await modelRuntime.getAvailable(providerId, options); return models; },
    getProvider: (providerId) => modelRuntime.getProvider(providerId),
    ...(provider === undefined || id === undefined ? {} : { savedDefault: { provider, id } }),
  };
}, async () => {
  // Pi's own function, the one AgentSession.getAvailableThinkingLevels() runs
  // (agent-session.js 0.84.2), so the menu is pi's policy, not a copy of it.
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  return getSupportedThinkingLevels;
});

export const piListModels = piModelLister();
