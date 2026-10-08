import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "./fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

function processFor(runtime: string): FakeLineProcess {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (runtime === "codex" && typeof message?.id === "number") {
      let result: Record<string, unknown> = {};
      if (message.method === "thread/start") { result = { thread: { id: "thread" } }; }
      else if (message.method === "turn/start") { result = { turn: { id: "turn" } }; }
      process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

async function imageFixture(): Promise<{ readonly dir: string; readonly image: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-input-transport-"));
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }); });
  const image = path.join(dir, "dot.png");
  await writeFile(image, "png");
  return { dir, image };
}

for (const [runtime, open] of [["claude", claudeSession], ["codex", codexSession]] as const) {
  test.each(["prompt", "steer", "queue"] as const)(`${runtime}: empty %s never writes to the process`, async (kind) => {
    const fake = processFor(runtime);
    const session = await open({ kind: "available", via: "executable", command: runtime }, { cwd: process.cwd() });
    try {
      const before = [...fake.written];
      const control = session[kind];
      expect(control).toBeDefined();
      const result = await control?.("", { images: [] });
      expect(result?.response.body).toEqual({ kind: "rejected", code: "unsupported", reason: "empty input: give text or images" });
      expect(fake.written).toEqual(before);
    } finally {
      await session.dispose();
    }
  });

  test(`${runtime}: an image-only prompt writes no text block`, async () => {
    const { dir, image } = await imageFixture();
    const fake = processFor(runtime);
    const session = await open({ kind: "available", via: "executable", command: runtime }, { cwd: dir });
    try {
      const result = await session.prompt("", { images: [{ path: image }] });
      expect(result.kind).toBe("accepted");
      const message = asRecord(JSON.parse(fake.written.at(-1) ?? "null"));
      const content = runtime === "claude" ? asRecord(message?.message)?.content : asRecord(message?.params)?.input;
      expect(content).toEqual(runtime === "claude"
        ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") } }]
        : [{ type: "localImage", path: image }]);
    } finally {
      await session.dispose();
    }
  });
}
