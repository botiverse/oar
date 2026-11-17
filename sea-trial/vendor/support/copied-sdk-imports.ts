import { registerHooks, type ModuleHooks } from "node:module";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve the copy's external imports exactly where the installed SDK resolves them. */
export function copiedSdkImports(entry: string, copy: string): ModuleHooks {
  const prefix = pathToFileURL(`${copy}${sep}`).href;
  return registerHooks({ resolve(specifier, context, nextResolve) {
    const external = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":");
    const parentURL = external && context.parentURL?.startsWith(prefix) === true ? pathToFileURL(entry).href : context.parentURL;
    return nextResolve(specifier, { ...context, parentURL });
  } });
}
