/* oxlint-disable import/max-dependencies -- The runtime declaration imports one module per capability. */
import { runtimeBrands } from "../../brands.js";
import type { ProviderAuthReader } from "../../contracts/provider-auth.js";
import { createPiInventories } from "./inventory.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { piInstallation } from "./installation.js";
import { type piListModels, piModelLister } from "./list-models.js";
import { piRefusedSessionOptions } from "./open.js";
import { createPiSession } from "./session.js";
import { onFirstCall } from "../../shared/lazy.js";
import { piRpcRefusedSessionOptions } from "./rpc/open.js";
import { piReaderForEnvironment, refuseChangedPiReaderEnvironment } from "./reader-environment.js";

import type { PiRuntimeOptions } from "./options.js";

export type { PiRuntimeOptions } from "./options.js";

const piProviders: ProviderAuthReader = async (_installation, options) => {
  const { createPiProviderAuth } = await import("./auth.js");
  const facade = await createPiProviderAuth();
  return facade.listProviders({ resolve: options.resolve });
};

/**
 * The bundled Pi runtime, embedded through the Pi SDK dependency. Account
 * usage is intentionally absent: Pi runs on provider API keys and has no
 * subscription usage surface to observe.
 */
export function createPiRuntime(options: PiRuntimeOptions = {}): Runtime & { readonly installation: typeof piInstallation; readonly listModels: typeof piListModels } {
  const subprocess = options.execution === "subprocess";
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JavaScript hosts can bypass the discriminated option type.
  if (!subprocess && options.command !== undefined) { throw new Error("A Pi command requires execution: subprocess"); }
  if (options.args !== undefined && options.command === undefined) { throw new Error("Pi command arguments require command"); }
  const inventories = createPiInventories(options);
  const tools: typeof inventories.tools = async (installation, readOptions = {}) => {
    if (subprocess) { refuseChangedPiReaderEnvironment(readOptions.env); }
    const result = await inventories.tools(installation, readOptions);
    return result;
  };
  const runtime = defineRuntime({
    id: "pi",
    brand: runtimeBrands.pi,
    refusedSessionOptions: subprocess ? piRpcRefusedSessionOptions : piRefusedSessionOptions,
    mcpToolsListChanged: "full",
    ...inventories,
    skills: subprocess ? piReaderForEnvironment(inventories.skills, onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcSkillReader(options); })) : inventories.skills,
    commands: subprocess ? piReaderForEnvironment(inventories.commands, onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcCommandReader(options); })) : inventories.commands,
    tools,
    installation: piInstallation,
    providers: async (installation, readOptions) => {
      if (subprocess) { refuseChangedPiReaderEnvironment(readOptions.env); }
      const result = await piProviders(installation, readOptions);
      return result;
    },
    listModels: subprocess
      ? piReaderForEnvironment(piModelLister(options), onFirstCall(async () => { const rpc = await import("./rpc/readers.js"); return rpc.piRpcModelLister(options); }))
      : piModelLister(options),
    session: subprocess ? onFirstCall(async () => { const rpc = await import("./rpc/session.js"); return rpc.createPiRpcSession(options); }) : createPiSession(options),
  });
  return runtime;
}

export const piRuntime = createPiRuntime();

export { piListModels, projectPiModels } from "./list-models.js";
export { piSession } from "./session.js";
export { createPiProviderAuth } from "./auth.js";
export type { PiProviderAuthOptions } from "./auth.js";
