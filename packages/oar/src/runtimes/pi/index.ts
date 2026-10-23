import { runtimeBrands } from "../../brands.js";
import { piCommands, piSkills, piTools } from "./inventory.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { piInstallation } from "./installation.js";
import { piListModels } from "./list-models.js";
import { piRefusedSessionOptions } from "./open.js";
import { piSession } from "./session.js";
import { onFirstCall } from "../../shared/lazy.js";
import { piRpcRefusedSessionOptions } from "./rpc/open.js";

export type PiRuntimeOptions = {
  /** The embedded SDK remains the default. */
  readonly execution?: "in-process";
  readonly command?: never;
  readonly args?: never;
} | {
  /** One native RPC process per session. */
  readonly execution: "subprocess";
  /** A Pi CLI executable, as a path or PATH command, never a shell expression. */
  readonly command?: string;
  /** Prefix arguments, for example a host binary's Pi subcommand. Requires command. */
  readonly args?: readonly string[];
};

/** Choose the session's execution location without changing the bundled Pi version. */
export function createPiRuntime(options: PiRuntimeOptions = {}): Runtime & { readonly installation: typeof piInstallation; readonly listModels: typeof piListModels } {
  const subprocess = options.execution === "subprocess";
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JavaScript hosts can bypass the discriminated option type.
  if (!subprocess && options.command !== undefined) { throw new Error("A Pi command requires execution: subprocess"); }
  if (options.args !== undefined && options.command === undefined) { throw new Error("Pi command arguments require command"); }
  return defineRuntime({
    id: "pi", brand: runtimeBrands.pi,
    refusedSessionOptions: subprocess ? piRpcRefusedSessionOptions : piRefusedSessionOptions,
    mcpToolsListChanged: "full",
    skills: piSkills, commands: piCommands, tools: piTools,
    installation: piInstallation, listModels: piListModels,
    session: subprocess ? onFirstCall(async () => { const rpc = await import("./rpc/session.js"); return rpc.createPiRpcSession(options.command, options.args); }) : piSession,
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
