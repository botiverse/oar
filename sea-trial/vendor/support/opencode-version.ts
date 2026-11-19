import { opencodeRuntime } from "../../../packages/oar/src/runtimes/opencode/index.js";
import { opencodeMajor } from "../../../packages/oar/src/runtimes/opencode/version.js";

/** Both OpenCode lines use the same backend and command name. Read the selected installation. */
export async function isOpencodeV2Aimock(): Promise<boolean> {
  if (process.env.OAR_TEST !== "opencode-aimock") { return false; }
  const installation = await opencodeRuntime.installation();
  return installation.kind === "available" && installation.via === "executable" && await opencodeMajor(installation) === 2;
}
