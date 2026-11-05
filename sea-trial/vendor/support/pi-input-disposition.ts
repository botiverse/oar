import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getTextContent, type LLMock } from "@copilotkit/aimock";
import type { Session, RuntimeEventBody } from "../../../packages/oar/src/contracts/session.js";
import { startPiAimock } from "../../harness/aimock.js";
import { runtimeUnderTest } from "../../harness/subject.js";
import { piTestRuntime } from "./pi-runtime.js";

export const inputId = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
export async function until(ready: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!await ready() && Date.now() < end) { await sleep(10); }
  return ready();
}
export const ends = (session: Session): readonly RuntimeEventBody[] => session.records().flatMap(record => record.kind === "frame"
  ? record.body.events.filter(event => event.kind === "turn_ended") : []);
interface PiInputFixture {
  session: Session;
  requests: string[];
  gate(text: string): PromiseWithResolvers<void>;
  hooks(): Promise<unknown[]>;
  close(): Promise<void>;
}
export async function fixture(extension: string, hold: RegExp | null = null, latency = 30, settings?: Record<string, unknown>): Promise<PiInputFixture> {
  const requests: string[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const gate = (text: string): PromiseWithResolvers<void> => {
    let value = gates.get(text);
    if (!value) { value = Promise.withResolvers<void>(); gates.set(text, value); }
    return value;
  };
  const environment = await startPiAimock((mock: LLMock) => { mock.on({ predicate: () => true }, async request => {
    const text = getTextContent(request.messages.findLast(message => message.role === "user")?.content ?? null) ?? "";
    requests.push(text);
    await (hold?.test(text) === true ? gate(text).promise : sleep(latency));
    return { content: "reply" };
  }); }, settings === undefined ? {} : { settings });
  const dir = process.env.OAR_PI_AGENT_DIR;
  if (dir === undefined) { throw new Error("Missing isolated Pi agent directory"); }
  const hooklog = path.join(dir, "handled-hooks.log");
  await mkdir(path.join(dir, "extensions"), { recursive: true });
  await writeFile(path.join(dir, "extensions", "handled-probe.ts"), `
    import { appendFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    export default pi => {
      const note = value => appendFileSync(${JSON.stringify(hooklog)}, JSON.stringify(value) + "\\n");
      pi.on("input", event => { note({ type: "input", text: event.text }); });
      ${extension}
    }
  `);
  const session = await runtimeUnderTest(piTestRuntime).startSession({ model: "aimock/aimock-model" });
  return {
    session, requests, gate,
    hooks: async (): Promise<unknown[]> => {
      const content = await readFile(hooklog, "utf8").catch(() => "");
      return content.trim().split("\n").filter(Boolean).map(line => {
        const hook: unknown = JSON.parse(line);
        return typeof hook === "object" && hook !== null && "text" in hook ? hook.text : undefined;
      });
    },
    close: async (): Promise<void> => { for (const value of gates.values()) { value.resolve(); } await session.dispose(); await environment.stop(); },
  };
}

