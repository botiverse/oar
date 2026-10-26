import { environmentValue } from "./environment.js";
import { userInfo } from "node:os";

/** Match a child's home lookup, including removal of the host HOME/USERPROFILE. */
export function environmentHome(env: Readonly<NodeJS.ProcessEnv>): string {
  return environmentValue(env, process.platform === "win32" ? "USERPROFILE" : "HOME") ?? userInfo().homedir;
}
