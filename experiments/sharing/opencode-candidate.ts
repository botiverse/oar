/** Explicit experiment composition; never exported by the package or selected by production admission. */
import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
import { defineRuntime, type Runtime } from "../../packages/oar/src/contracts/runtime.js";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import { isOpenCodeSharedVersion } from "../../packages/oar/src/runtimes/opencode/sharing-admission.js";
import { onFirstCall } from "../../packages/oar/src/shared/lazy.js";

/** Historical experimental cells only; production admission is unconditionally closed. */
export function opencodeCandidateRefusal(installation: AvailableInstallation, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const version = installation.via === "executable"
    ? /^(?:opencode\s+)?v?(?<version>\d+\.\d+\.\d+)$/u.exec(installation.version?.trim() ?? "")?.groups?.version : undefined;
  if (!isOpenCodeSharedVersion(version)) {
    return "OpenCode shared placement is verified only for native 2.2.3 or 2.2.5; the installed version is different or unknown";
  }
  if (!((platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64"))) {
    return "OpenCode 2.2.3 and 2.2.5 shared placement is verified only on Linux x64, macOS arm64 and Windows x64";
  }
  return null;
}

export function experimentalOpenCodeRuntime(refusal = opencodeCandidateRefusal): Runtime {
  return defineRuntime({ id: "opencode", installation: opencodeRuntime.installation,
    session: onFirstCall(async () => { const { opencodeSession } = await import("../../packages/oar/src/runtimes/opencode/session.js"); return opencodeSession; }) },
    { execution: "process", shared: { refusal,
      session: () => onFirstCall(async () => { const { createOpenCodeSharedSession } = await import("../../packages/oar/src/runtimes/opencode/shared-session.js"); return createOpenCodeSharedSession(); }) } });
}
