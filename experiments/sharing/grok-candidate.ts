/** Experimental adapter only. The public Grok runtime refuses all shared placement. */
import { defineRuntime, type Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
import { grokRuntime } from "../../packages/oar/src/runtimes/grok/index.js";
import { grokSession } from "../../packages/oar/src/runtimes/grok/session.js";
import { createGrokSharedSession } from "../../packages/oar/src/runtimes/grok/shared-session.js";
import { isGrokSharedVersion } from "../../packages/oar/src/runtimes/grok/sharing-admission.js";

export function grokCandidateRefusal(installation: AvailableInstallation, platform: NodeJS.Platform = process.platform, arch = process.arch): string | null {
  const version = installation.via === "executable" ? /^grok (?<version>\d+\.\d+\.\d+) \([a-f\d]+\)(?: \[stable\])?$/u.exec(installation.version?.trim() ?? "")?.groups?.version : undefined;
  if (!isGrokSharedVersion(version)) { return "Grok experiment requires exact native 1.0.70 stable"; }
  return ((platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64"))
    ? null : "Grok experiment supports only Linux x64, macOS arm64 and Windows x64";
}

export function experimentalGrokRuntime(): Runtime {
  return defineRuntime({ id: "grok", installation: grokRuntime.installation, session: grokSession },
    { execution: "process", shared: { refusal: grokCandidateRefusal, session: () => createGrokSharedSession() } });
}
