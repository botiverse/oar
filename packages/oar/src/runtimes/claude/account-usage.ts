import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "../../contracts/account-usage.js";
import { resolveExecutable, runExecutable } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";

function resultText(stdout: string): string | null {
  const result = asRecord(parseJson(stdout))?.result;
  return typeof result === "string" && result.trim().length > 0 ? result : null;
}

export function projectClaudeUsage(content: string): AccountUsageSnapshot {
  const windows: AccountUsageWindow[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(.+?): (\d+(?:\.\d+)?)% used(?: · resets .+)?$/u.exec(line.trim());
    const label = match?.[1];
    const percentage = match?.[2];
    if (label === undefined || percentage === undefined) {
      continue;
    }
    const usedPercent = Number(percentage);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      continue;
    }
    windows.push({
      label,
      usedRatio: Number((usedPercent / 100).toFixed(6)),
    });
  }
  if (windows.length === 0) {
    throw new Error("Claude returned no usable account usage windows");
  }
  return {
    kind: "available",
    rateLimited: windows.some((window) => window.usedRatio >= 1),
    windows,
  };
}

/**
 * `claude -p /usage --output-format json` has two observed shapes.
 * Without login, `result` is only an invocation summary:
 *
 * ```json
 * {
 *   "type": "result",
 *   "total_cost_usd": 0,
 *   "usage": { "input_tokens": 0, "output_tokens": 0 },
 *   "result": "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write"
 * }
 * ```
 *
 * With a subscription login, `result` contains account usage windows:
 *
 * ```json
 * {
 *   "type": "result",
 *   "result": "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 7% used · resets Aug 21 at 7:39pm (Asia/Shanghai)\nCurrent week (all models): 0% used · resets Aug 28 at 2:59pm (Asia/Shanghai)\nCurrent week (Fable): 0% used"
 * }
 * ```
 *
 * Reset values are deliberately omitted until arbitrary IANA zones can be normalized reliably.
 */
export const claudeAccountUsage: AccountUsageReader = async (options = {}) => {
  const command = resolveExecutable("claude");
  if (command === null) {
    return { kind: "unsupported" };
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env = { ...process.env, CLAUDECODE: undefined };
  const auth = await runExecutable(command, ["auth", "status", "--json"], { env, timeoutMs });
  if (!auth.ok && auth.exitCode === null) {
    throw new Error("Failed to read Claude authentication status");
  }
  if (!auth.ok || asRecord(parseJson(auth.stdout))?.loggedIn === false) {
    return { kind: "reauth_required" };
  }

  const usage = await runExecutable(command, ["-p", "/usage", "--output-format", "json"], {
    env,
    timeoutMs,
  });
  if (!usage.ok && usage.exitCode === null) {
    throw new Error("Failed to execute Claude account usage");
  }
  if (!usage.ok) {
    const output = `${usage.stdout}\n${usage.stderr}`;
    if (/auth(?:entication)?\s*(?:missing|required)|log(?:ged)?\s*in/iu.test(output)) {
      return { kind: "reauth_required" };
    }
    throw new Error("Claude account usage command failed");
  }
  const content = resultText(usage.stdout);
  if (content === null) {
    throw new Error("Claude returned no account usage result");
  }
  return projectClaudeUsage(content);
};
