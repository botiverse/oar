/** Inspect native result field names without copying model content or account data. */
import assert from "node:assert/strict";
import { awaitTurnEnd } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { selectBackend } from "../../sea-trial/harness/backends.js";

for (const name of ["qwen-aimock", "qoder-native"]) {
  // oxlint-disable-next-line no-await-in-loop -- Each isolated native fixture is closed before opening the next.
  await (async (): Promise<void> => {
    const backend = await selectBackend(name);
    try {
      const installation = await backend.runtime.installation?.();
      assert.ok(installation?.kind === "available");
      const session = await backend.runtime.session(installation, { cwd: process.cwd() });
      const timer = setTimeout(() => { void session.dispose(); }, 30_000);
      try {
        const started = await session.prompt("OAR_RESULT_IDENTITY");
        assert.equal(started.response.body.kind, "accepted");
        const outcome = await awaitTurnEnd(session, started.request.seq);
        assert.equal(outcome.kind, "completed");
        const results = session.records().flatMap((record) => {
          if (record.kind !== "frame") { return []; }
          const native = asRecord(record.body.native);
          if (native?.type !== "result") { return []; }
          return [{ fields: Object.keys(native).toSorted(), singular: typeof native.user_message_uuid === "string", plural: Array.isArray(native.user_message_uuids) }];
        });
        assert.ok(results.length > 0);
        console.log(JSON.stringify({ runtime: name, version: installation.via === "executable" ? installation.version : installation.via, results }));
      } finally { clearTimeout(timer); await session.dispose(); }
    } finally { await backend.close?.(); await backend.aimock?.stop(); }
  })();
}
