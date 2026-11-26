import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { runTurn } from "../harness/session-controls.js";
import type { TrialCase } from "../harness/runner.js";
import { startHttpEcho } from "../vendor/support/echo-mcp.js";

export const sessionCapabilitiesCases: readonly TrialCase[] = [
  {
    // What the runtime declares before open is what the opened session offers;
    // an absent field promises nothing.
    id: "session.capabilities-match-declaration",
    requires: ["installation", "session", "sessionCapabilities"],
    async run(subject) {
      const installation = await subject.runtime.installation?.();
      assert.ok(installation?.kind === "available", "the subject opens sessions from an available installation");
      const declared = subject.runtime.sessionCapabilities?.(installation);
      assert.ok(declared !== undefined);
      if (declared.sideQuestion === true) {
        assert.equal(typeof subject.runtime.sideQuestion, "function", "declared sideQuestion requires the runtime operation");
      }
      const session = await subject.startSession();
      try {
        if (declared.steer !== undefined) {
          assert.equal(session.steer !== undefined, declared.steer, "declared steer matches Session.steer");
        }
        if (declared.stopTask !== undefined) {
          assert.equal(session.stopTask !== undefined, declared.stopTask, "declared stopTask matches Session.stopTask");
        }
        if (declared.answer !== undefined) {
          assert.equal(session.answer !== undefined, declared.answer, "declared answer matches Session.answer");
        }
        if (declared.images !== undefined) {
          assert.equal(session.capabilities.images, declared.images, "declared images matches capabilities.images");
        }
        const reportsContext = declared.contextUsage?.tokens === true || declared.contextUsage?.contextWindow === true;
        if (declared.nativeSessionFile !== undefined) {
          assert.equal(typeof session.nativeSessionFile === "function", declared.nativeSessionFile, "declared nativeSessionFile matches the session method");
        }
        if (reportsContext || declared.nativeSessionFile === true) {
          assert.deepEqual(await runTurn(session, "hello"), { kind: "completed" });
        }
        if (declared.nativeSessionFile === true) {
          const file = await session.nativeSessionFile?.();
          assert.ok(typeof file === "string" && isAbsolute(file), "nativeSessionFile returns an absolute path after a completed root turn");
          const status = await stat(file);
          assert.ok(status.isFile(), "the native session file exists");
        }
        if (reportsContext) {
          const context = session.contextUsage().value;
          assert.ok(context !== null, "declared contextUsage must be non-null after a completed root turn");
          if (declared.contextUsage.tokens) {
            assert.equal(typeof context.tokens, "number", "declared contextUsage.tokens must be a number after a completed root turn");
          }
          if (declared.contextUsage.contextWindow) {
            assert.ok(typeof context.contextWindow === "number" && context.contextWindow > 0, "declared contextUsage.contextWindow must be a positive number after a completed root turn");
          }
        }
      } finally {
        await session.dispose();
      }
      if (declared.mcpTransports !== undefined) {
        if (declared.mcpTransports.includes("http")) {
          const http = await startHttpEcho();
          try {
            const withHttp = await subject.startSession({ mcpServers: [{ name: "oar_cap_http", type: "http", url: http.url }] });
            await withHttp.dispose();
          } finally {
            http.stop();
          }
        } else {
          await assert.rejects(
            async () => { await subject.startSession({ mcpServers: [{ name: "oar_cap_http", type: "http", url: "http://127.0.0.1:1/mcp" }] }); },
            (error: unknown) => error instanceof UnsupportedOptionError && error.option === "mcpServers",
            "runtime omitting http from declared mcpTransports must refuse HTTP mcpServers with UnsupportedOptionError",
          );
        }
      }
    },
  },
];
