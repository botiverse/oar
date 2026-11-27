/* oxlint-disable import/max-dependencies -- The runtime declaration imports one module per capability. */
import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import type { ProviderAuthReader } from "../../contracts/provider-auth.js";
import { createPiInventories } from "./inventory.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { unsupportedInventory } from "../../shared/inventory.js";
import { isStandalonePiCommand, piInstallationFor, type piInstallation } from "./installation.js";
import { createPiInstall, createPiInstallPlan } from "./install.js";
import { piCheckUpdate, piUpgrade } from "./update.js";
import { piCredentials } from "./credential-shape.js";
import { type piListModels, piModelLister } from "./list-models.js";
import { piRefusedSessionOptions } from "./open.js";
import { createPiSession } from "./session.js";
import { onFirstCall } from "../../shared/lazy.js";
import { piRpcRefusedSessionOptions } from "./rpc/open.js";
import { piReaderForEnvironment, refuseChangedPiReaderEnvironment } from "./reader-environment.js";
import { PI_RPC_MINIMUM_VERSION } from "./rpc/version.js";

import type { PiRuntimeOptions } from "./options.js";

export type { PiRuntimeOptions } from "./options.js";

const piProviders: ProviderAuthReader = async (_installation, options) => {
  const { createPiProviderAuth } = await import("./auth.js");
  const facade = await createPiProviderAuth();
  return facade.listProviders({ resolve: options.resolve });
};

/**
 * The Pi runtime: embedded through the Pi SDK dependency by default, or
 * backed by an RPC subprocess (`execution: "subprocess"`, optionally pinned to
 * an external `command` executable). Account usage is absent: Pi runs on
 * provider keys and exposes no unified subscription usage surface.
 */
export function createPiRuntime(options: PiRuntimeOptions = {}): Runtime & { readonly installation: typeof piInstallation; readonly listModels: typeof piListModels } {
  const subprocess = options.execution === "subprocess";
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JavaScript hosts can bypass the discriminated option type.
  if (!subprocess && options.command !== undefined) { throw new Error("A Pi command requires execution: subprocess"); }
  if (options.args !== undefined && options.command === undefined) { throw new Error("Pi command arguments require command"); }
  const explicitCommand = subprocess && options.command !== undefined;
  const standaloneCli = isStandalonePiCommand(options);
  const installation = piInstallationFor(options);
  const inventories = createPiInventories(options);
  const tools: typeof inventories.tools = async (available, readOptions = {}) => {
    if (explicitCommand) {
      return unsupportedInventory("installation_unsupported", "Pi RPC with an explicit command has no native tools query");
    }
    if (subprocess) { refuseChangedPiReaderEnvironment(readOptions.env); }
    const result = await inventories.tools(available, readOptions);
    return result;
  };
  const skills = explicitCommand
    ? onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcSkillReader(options); })
    : (subprocess ? piReaderForEnvironment(inventories.skills, onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcSkillReader(options); })) : inventories.skills);
  const commands = explicitCommand
    ? onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcCommandReader(options); })
    : (subprocess ? piReaderForEnvironment(inventories.commands, onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcCommandReader(options); })) : inventories.commands);
  const listModels = explicitCommand
    ? onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcModelLister(options); })
    : (subprocess ? piReaderForEnvironment(piModelLister(options), onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcModelLister(options); })) : piModelLister(options));
  const runtime = defineRuntime({
    id: "pi",
    sessionCapabilities: () => ({ taskEventTypes: [], nativeSessionFile: true, steer: true, images: true, contextUsage: { tokens: true, contextWindow: true }, mcpTransports: ["stdio", "http"], stopTask: false }),
    ...(subprocess ? { minVersion: PI_RPC_MINIMUM_VERSION } : {}),
    manualCompaction: { kind: "supported", activeTurn: "reject" },
    brand: runtimeBrands.pi, verifiedPlatforms: verifiedPlatforms.pi,
    credentials: piCredentials,
    refusedSessionOptions: subprocess ? piRpcRefusedSessionOptions : piRefusedSessionOptions,
    resumedSessionOptions: {
      systemPrompt: { provided: "immediate", omitted: "default" },
      appendSystemPrompt: { provided: "immediate", omitted: "default" },
    },
    mcpToolsListChanged: "full",
    ...inventories,
    skills,
    commands,
    tools,
    installation,
    ...(standaloneCli ? {
      installPlan: createPiInstallPlan(installation),
      install: createPiInstall(installation),
      checkUpdate: piCheckUpdate,
      upgrade: piUpgrade,
    } : {}),
    providers: async (available, readOptions) => {
      if (subprocess) { refuseChangedPiReaderEnvironment(readOptions.env); }
      const result = await piProviders(available, readOptions);
      return result;
    },
    listModels,
    session: subprocess ? onFirstCall(async () => { const rpc = await import("./rpc/session.js"); return rpc.createPiRpcSession(options); }) : createPiSession(options),
  }, { execution: subprocess ? "process" : "in_process" });
  return runtime;
}

export const piRuntime = createPiRuntime();

export { createPiProviderAuth } from "./auth.js";
export type { PiProviderAuthOptions } from "./auth.js";
