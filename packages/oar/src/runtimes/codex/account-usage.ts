import { spawn } from "node:child_process";
import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "../../contracts/account-usage.js";
import { resolveExecutable } from "../../shared/executable/index.js";
import { asNumber, asRecord, parseJson } from "../../shared/json.js";

type ReadOutcome =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "reauth_required" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error" };

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined;
}

function resetInstant(value: unknown): string | undefined {
  const raw = asNumber(value);
  if (raw === null) {
    return undefined;
  }
  const instant = new Date(raw >= 1_000_000_000_000 ? raw : raw * 1000);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : undefined;
}

function windowLabel(value: unknown): string {
  const minutes = asNumber(value);
  if (minutes === null || minutes <= 0) {
    return "Usage limit";
  }
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} minutes`;
}

/**
 * Native evidence comes from `codex app-server --listen stdio://`, followed by
 * `initialize` and `account/rateLimits/read`. A representative response is:
 *
 * ```json
 * {
 *   "rateLimits": {
 *     "primary": { "usedPercent": 50, "windowDurationMins": 10080, "resetsAt": 1787820410 },
 *     "secondary": null,
 *     "planType": "pro",
 *     "rateLimitReachedType": null
 *   },
 *   "rateLimitsByLimitId": {
 *     "codex_bengalfox": {
 *       "limitName": "GPT-5.3-Codex-Spark",
 *       "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1787322278 },
 *       "secondary": { "usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1787909078 },
 *       "planType": "pro"
 *     }
 *   }
 * }
 * ```
 */
export function projectCodexUsage(result: unknown): AccountUsageSnapshot {
  const root = asRecord(result);
  const historical = asRecord(root?.rateLimits);
  const indexed = asRecord(root?.rateLimitsByLimitId);
  const buckets = indexed !== null && Object.keys(indexed).length > 0
    ? Object.values(indexed).map((value) => asRecord(value))
    : [historical];
  const windows: AccountUsageWindow[] = [];
  let rateLimited = false;
  let plan: string | undefined = undefined;

  for (const bucket of buckets) {
    if (bucket === null) {
      continue;
    }
    plan ??= text(bucket.planType);
    rateLimited ||= bucket.rateLimitReachedType !== null
      && bucket.rateLimitReachedType !== undefined;

    for (const kind of ["primary", "secondary"] as const) {
      const candidate = asRecord(bucket[kind]);
      if (candidate === null) {
        continue;
      }
      const usedPercent = asNumber(candidate.usedPercent);
      if (usedPercent === null || usedPercent < 0 || usedPercent > 100) {
        continue;
      }
      const resetsAt = resetInstant(candidate.resetsAt);
      windows.push({
        label: windowLabel(candidate.windowDurationMins),
        usedRatio: Number((usedPercent / 100).toFixed(6)),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
      rateLimited ||= usedPercent >= 100;
    }
  }

  if (windows.length === 0) {
    throw new Error("Codex returned no usable account usage windows");
  }
  return {
    kind: "available",
    ...(plan === undefined ? {} : { plan }),
    rateLimited,
    windows,
  };
}

async function readFromAppServer(command: string, timeoutMs: number): Promise<ReadOutcome> {
  const result = await new Promise<ReadOutcome>((resolve) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let finished = false;
    const finish = (outcome: ReadOutcome): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      // oxlint-disable-next-line promise/no-multiple-resolved -- finished is the settlement guard
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ kind: "error" });
    }, timeoutMs);
    child.once("error", () => {
      finish({ kind: "error" });
    });
    child.once("exit", () => {
      finish({ kind: "error" });
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        const message = asRecord(parseJson(line));
        if (message?.id === "initialize") {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: "usage", method: "account/rateLimits/read", params: {} })}\n`);
        } else if (message?.id === "usage") {
          const error = asRecord(message.error);
          if (error === null) {
            finish({ kind: "ok", result: message.result });
          } else {
            const errorText = text(error.message) ?? "";
            if (/authentication required/iu.test(errorText)) {
              finish({ kind: "reauth_required" });
            } else if (/method not found|not supported/iu.test(errorText)) {
              finish({ kind: "unsupported" });
            } else {
              finish({ kind: "error" });
            }
          }
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } },
    })}\n`);
  });
  return result;
}

export const codexAccountUsage: AccountUsageReader = async (options = {}) => {
  const command = resolveExecutable("codex");
  if (command === null) {
    return { kind: "unsupported" };
  }
  const outcome = await readFromAppServer(command, options.timeoutMs ?? 8000);
  if (outcome.kind === "ok") {
    return projectCodexUsage(outcome.result);
  }
  if (outcome.kind === "reauth_required") {
    return { kind: "reauth_required" };
  }
  if (outcome.kind === "unsupported") {
    return { kind: "unsupported" };
  }
  throw new Error("Failed to read Codex account usage");
};
