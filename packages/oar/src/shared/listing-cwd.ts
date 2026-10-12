import { resolve as resolvePath } from "node:path";
import type { ListModelsOptions } from "../contracts/list-models.js";

/** `ListModelsOptions.cwd` resolved against the host's cwd, which is also its default. */
export function listingCwd(options: ListModelsOptions): string {
  return resolvePath(options.cwd ?? process.cwd());
}
