import { runtimeBrands } from "../../brands.js";
import { piCommands, piSkills, piTools } from "./inventory.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { piInstallation } from "./installation.js";
import { piListModels } from "./list-models.js";
import { piRefusedSessionOptions } from "./open.js";
import { piSession } from "./session.js";
import { onFirstCall } from "../../shared/lazy.js";
import { piRpcRefusedSessionOptions } from "./rpc/open.js";

export interface PiRuntimeOptions {
  /** One bundled native RPC process per session, or the existing embedded SDK (default). */
  readonly execution?: "in-process" | "subprocess";
}

/** Choose the session's execution location without changing the bundled Pi version. */
export function createPiRuntime(options: PiRuntimeOptions = {}): Runtime & { readonly installation: typeof piInstallation; readonly listModels: typeof piListModels } {
  const subprocess = options.execution === "subprocess";
  return defineRuntime({
    id: "pi", brand: runtimeBrands.pi,
    refusedSessionOptions: subprocess ? piRpcRefusedSessionOptions : piRefusedSessionOptions,
    mcpToolsListChanged: "full",
    skills: piSkills, commands: piCommands, tools: piTools,
    installation: piInstallation, listModels: piListModels,
    session: subprocess ? onFirstCall(async () => { const rpc = await import("./rpc/session.js"); return rpc.piRpcSession; }) : piSession,
  });
}

/**
 * The bundled Pi runtime, embedded through the Pi SDK dependency. Account
 * usage is intentionally absent: Pi runs on provider API keys and has no
 * subscription usage surface to observe.
 */
export const piRuntime = createPiRuntime();

export { piListModels, projectPiModels } from "./list-models.js";
export { piSession } from "./session.js";
