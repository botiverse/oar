import type { AvailableInstallation } from "../../contracts/installation.js";
import { bundledBottegaCli } from "./installation.js";

/** How to start bottega for an installation: the probed executable, or the bundled command line under this Node. */
export function bottegaCommand(installation: AvailableInstallation, args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  if (installation.via === "executable") { return { command: installation.command, args }; }
  const cli = bundledBottegaCli();
  if (cli === null) { throw new Error("The bundled bottega (@botiverse/bottega) is no longer installed in this host"); }
  return { command: process.execPath, args: [cli, ...args] };
}
