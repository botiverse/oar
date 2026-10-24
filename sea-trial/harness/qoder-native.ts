import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { record } from "./trace.js";

/** Preserve cleanup boundaries even if a test times out after the native process exits. */
async function cleanupPhase(home: string, phase: string, action: () => Promise<void>): Promise<void> {
  const started = performance.now();
  function report(outcome: string, error?: unknown): void {
    const artifacts = process.env.OAR_TRIAL_RUN_DIR;
    if (artifacts === undefined || artifacts === "") { return; }
    const observation = { kind: "qoder_cleanup", fixture: path.basename(home), phase, outcome,
      elapsedMs: performance.now() - started,
      ...(error instanceof Error && "code" in error ? { code: String(error.code) } : {}) };
    record(observation);
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  }
  report("started");
  try { await action(); report("completed"); }
  catch (error) { report("failed", error); throw error; }
}

export interface QoderReply {
  readonly text?: string;
  readonly chunks?: readonly string[];
  readonly tool?: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
  readonly input?: number;
  readonly output?: number;
}
export interface QoderNativeEnv {
  readonly home: string;
  readonly options: SessionOptions;
  stop(this: void): Promise<void>;
}
/** Qoder's own fake-response reader drives its real model loop, with no login or network provider. */
export async function startQoderNative(replies: readonly QoderReply[], delayMs = 1): Promise<QoderNativeEnv> {
  const home = await mkdtemp(path.join(tmpdir(), "oar-qoder-native-"));
  const cwd = path.join(home, "project"); await mkdir(cwd);
  const responses = path.join(home, "responses.jsonl");
  await writeFile(responses, `${replies.map((reply) => JSON.stringify({ method: "generateContentStream", response: (reply.chunks ?? [reply.text ?? "ok"]).map((text) => ({
    candidates: [{ content: { parts: reply.tool === undefined ? [{ text }] : [{ functionCall: reply.tool }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: reply.input ?? 10, candidatesTokenCount: reply.output ?? 2 },
  })) })).join("\n")  }\n`);
  const options: SessionOptions = { cwd,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"), QODER_FAKE_STREAM_DELAY_MS: String(delayMs),
      QODER_PERSONAL_ACCESS_TOKEN: "", QODER_API_KEY: "", NO_PROXY: "*" },
    launchArgs: ["--settings", JSON.stringify({ security: { auth: { useExternal: true } } }), "--fake-responses", responses],
  };
  return { options, home, stop: async (): Promise<void> => {
    try {
      // Only this isolated, unauthenticated replay fixture retains native startup logs.
      const artifacts = process.env.OAR_TRIAL_RUN_DIR;
      if (artifacts !== undefined && artifacts !== "") {
        const destination = path.join(artifacts, "qoder-native", path.basename(home));
        try { await cleanupPhase(home, "copy_logs", async () => { await cp(path.join(home, ".qoder", "logs"), destination, { recursive: true }); }); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; } }
      }
    } finally { await cleanupPhase(home, "remove_home", async () => { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }); }
  } };
}
