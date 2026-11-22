import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutableInstallation } from "../../packages/oar/src/contracts/installation.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { kimiSession } from "../../packages/oar/src/runtimes/kimi/session.js";
import { parseJson } from "../../packages/oar/src/shared/json.js";

const FAKE_KIMI_PATH = resolve(import.meta.dirname, "fake-kimi-kap.mjs");
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export interface KapTestFixture {
  readonly dir: string;
  readonly extraDir: string;
  readonly bin: string;
  readonly logFile: string;
  readonly imagePath: string;
  readLog(): Record<string, unknown>[];
  open(version: string, options?: Partial<SessionOptions>): Promise<Session>;
  cleanup(): void;
}

export function createKapTestFixture(): KapTestFixture {
  const dir = mkdtempSync(join(tmpdir(), "oar-kimi-kap-test-"));
  const extraDir = tmpdir();
  const bin = join(dir, "kimi");
  const logFile = join(dir, "fake.log");
  const imagePath = join(dir, "pixel.png");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_KIMI_PATH}" "$@"\n`, { mode: 0o755 });
  writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

  return {
    dir,
    extraDir,
    bin,
    logFile,
    imagePath,
    readLog: (): Record<string, unknown>[] => {
      try {
        const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
        return lines
          .map((line) => parseJson(line))
          .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
      } catch {
        return [];
      }
    },
    open: async (version, options = {}): Promise<Session> => {
      const inst: ExecutableInstallation = { kind: "available", via: "executable", command: bin, version };
      const session = await kimiSession(inst, { cwd: dir, ...options });
      return session;
    },
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { randomUUID } from "node:crypto";

export async function sleepMs(ms: number): Promise<void> {
  await delay(ms);
}

export async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<void> {
    if (predicate()) { return; }
    if (Date.now() > deadline) { throw new Error(message); }
    await delay(20);
    return poll();
  }
  return poll();
}

export async function finishAndDispose(session: Session, label: string): Promise<void> {
  await waitUntil(() => session.status().value.kind === "idle", `Timed out waiting for ${label}`);
  await session.dispose();
}

export async function waitTurnStarted(session: Session, label = "turn.started"): Promise<void> {
  await waitUntil(
    () => session.records().some((r) => r.kind === "frame" && r.body.type === "turn.started"),
    `Timed out waiting for ${label}`,
  );
}
