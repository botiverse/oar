import type { LineProcess } from "../../shared/executable/index.js";

/** 1.1.81 removed the SDK worker from the ordinary headless stream. */
export function qoderProtocol(version: string | undefined): "worker" | "daemon" {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version ?? "");
  if (parts === null) {
    throw new Error("Qoder version compatibility could not be determined; a readable stable CLI version is required to select its control and permission protocol");
  }
  const major = Number(parts[1]); const minor = Number(parts[2]); const patch = Number(parts[3]);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 81))) ? "daemon" : "worker";
}

/** Preserve the CLI's explicit environment credentials before local login. */
export function qoderDaemonAuth(env: NodeJS.ProcessEnv): Record<string, string> {
  const accessToken = env.QODER_PERSONAL_ACCESS_TOKEN ?? "";
  const serviceAccountKey = env.QODER_SERVICE_ACCOUNT_KEY ?? "";
  const jobToken = env.QODER_JOB_TOKEN ?? "";
  if (serviceAccountKey.length > 0 && (accessToken.length > 0 || jobToken.length > 0)) { throw new Error("Qoder service-account credentials cannot be combined with another explicit authentication credential"); }
  if (jobToken.length > 0 && accessToken.length === 0) { throw new Error("Qoder daemon job-token authentication requires a host callback and is not supported by OAR"); }
  if (accessToken.length > 0) { return { type: "accessToken", accessToken }; }
  if (serviceAccountKey.length > 0) { return { type: "serviceAccount", serviceAccountKey }; }
  return { type: "qodercli" };
}

/** Startup applies all flags together; include the choice without inventing a cause. */
export function qoderStartupError(error: unknown, effort: string | undefined): unknown {
  return effort === undefined ? error : new Error(`Qoder startup failed (requested effort ${JSON.stringify(effort)}): ${String(error)}`, { cause: error });
}

/** Only an OAR-owned protocol termination supplies an exit reason. */
export function qoderTerminationReason(child: LineProcess): string | undefined {
  const error = child.diagnostics().error;
  return error?.code === "QODER_PROTOCOL_ERROR" ? error.message : undefined;
}
