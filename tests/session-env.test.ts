import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../packages/oar/src/contracts/session.js";
import { sessionEnvironment } from "../packages/oar/src/shared/environment.js";
import { fixture as acpFixture } from "./fixtures/acp-session-support.js";
import { eventually, fakeAgent, fakeAgentBinary } from "./fixtures/process-tree.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const capture = new URL("fixtures/env-capture.mjs", import.meta.url).href;
const runtimes = allRuntimes.list().filter((runtime) => runtime.id !== "pi" && runtime.id !== "cursor");
afterEach(() => { vi.unstubAllEnvs(); });

// oxlint-disable-next-line max-statements -- Each runtime's full child/host lifecycle stays together for cleanup on failure.
test.each(runtimes)("$id: deletion and overrides reach the runtime and its tools without changing the host", async ({ id, session: open }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-session-env-"));
  const file = path.join(dir, "env.json");
  for (const key of ["OAR_ENV_REMOVE", "OAR_ENV_OVERRIDE", "OAR_ENV_KEEP", "CLAUDECODE"]) {
    vi.stubEnv(key, "inherited");
  }
  const env: SessionOptions["env"] = { OAR_ENV_CAPTURE_PATH: file, OAR_ENV_REMOVE: null, OAR_ENV_OVERRIDE: "replacement", OAR_ENV_EMPTY: "" };
  const command = fakeAgentBinary(dir, ["--import", capture, id === "claude" || id === "codex" ? fakeAgent : acpFixture, "session"]);
  try {
    const session = await open({ kind: "available", via: "executable", command }, { cwd: dir, env });
    try {
      expect(await eventually(() => existsSync(file), 5000)).toBe(true);
      const expected = { OAR_ENV_OVERRIDE: "replacement", OAR_ENV_KEEP: "inherited", OAR_ENV_EMPTY: "", ...(id === "claude" ? {} : { CLAUDECODE: "inherited" }) };
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ runtime: expected, tool: expected });
      expect(process.env.OAR_ENV_REMOVE).toBe("inherited");
      expect(process.env.OAR_ENV_OVERRIDE).toBe("inherited");
      expect(JSON.stringify(session.records())).not.toMatch(/OAR_ENV_|replacement/u);
    } finally {
      await session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows removal and overrides match inherited names without regard to case", () => {
  const inherited = { Path: "one", PATH: "two", Token: "secret", KEEP: "ok" };
  expect(sessionEnvironment({ path: "new", TOKEN: null, MISSING: null }, inherited, "win32")).toEqual({ path: "new", KEEP: "ok" });
  expect(inherited).toEqual({ Path: "one", PATH: "two", Token: "secret", KEEP: "ok" });
});

test("POSIX names remain case-sensitive and omitted env inherits unchanged", () => {
  const inherited = { TOKEN: "upper", token: "lower" };
  expect(sessionEnvironment({ TOKEN: null }, inherited, "linux")).toEqual({ token: "lower" });
  expect(sessionEnvironment(undefined, inherited, "linux")).toEqual(inherited);
});
