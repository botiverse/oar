import type { AvailableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { sessionExitReason } from "../../shared/executable/reported-stderr.js";
import type { LineProcess } from "../../shared/executable/index.js";
import type { SessionCredentials } from "../../shared/session-credentials.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { assertAdditionalDirectoriesCreatable } from "./kap-errors.js";
import { checkKimiKapLaunchArgs, checkKimiKapMcpServers, startKimiKapProcess, type KapBootInfo } from "./kap-protocol.js";
import { kimiRefusedSessionOptions } from "./options.js";

export type BootKapResult =
  | { readonly kind: "fallback_acp" }
  | {
      readonly kind: "ready";
      readonly cwd: string;
      readonly child: LineProcess;
      readonly boot: KapBootInfo;
      readonly exitReason: (reason: string | undefined) => string | undefined;
    };

export async function bootKapServer(
  installation: AvailableInstallation,
  options: SessionOptions,
  credentials: SessionCredentials,
): Promise<BootKapResult> {
  if (installation.via !== "executable") {
    return { kind: "fallback_acp" };
  }
  refuseSessionOptions(kimiRefusedSessionOptions, options);
  assertAdditionalDirectoriesCreatable(options);
  checkKimiKapLaunchArgs(options.launchArgs);
  checkKimiKapMcpServers(options.mcpServers);

  const { cwd } = options;
  const start = await startKimiKapProcess(
    installation.command,
    cwd,
    sessionEnvironment(options.env),
    options.launchArgs,
    (token) => { credentials.add(token); },
    credentials.redact,
  );
  if (start.kind === "fallback_acp") {
    return { kind: "fallback_acp" };
  }
  return {
    kind: "ready",
    cwd,
    child: start.child,
    boot: start.boot,
    exitReason: (reason) => sessionExitReason(start.child, reason, credentials.redact),
  };
}
