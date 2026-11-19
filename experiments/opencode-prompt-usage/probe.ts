/** Compare root prompt usage with provider steps and the final context update on two consecutive turns. */
import assert from "node:assert/strict";
import { opencodeRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

const [mode] = process.argv.slice(2);
assert.ok(mode === "whole-turn" || mode === "last-step", "Choose whole-turn or last-step for this release");
const installation = await opencodeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable", "Set OAR_OPENCODE_BIN to the selected binary");
interface StepUsage { readonly input_tokens: number; readonly output_tokens: number }
const calls: StepUsage[] = [];
const fixture = await startOpencodeAimock(mock => {
  mock.on({ predicate: () => true }, request => {
    const step = calls.length;
    const usage = { input_tokens: 100 * (step + 1), output_tokens: 10 * (step + 1) };
    calls.push(usage);
    if (step === 1) { assert.ok(request.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("OAR_STEP"))); }
    if (step === 0) {
      const name = request.tools?.some(tool => tool.function.name === "shell") === true ? "shell" : "bash";
      return { usage, toolCalls: [{ id: "call-measure", name, arguments: JSON.stringify({ command: "echo OAR_STEP", description: "Return a marker" }) }] };
    }
    return { usage, content: "Complete" };
  });
}, { enabled_providers: ["aimock"] });
try {
  const session = await opencodeRuntime.session(installation, { cwd: fixture.env.HOME ?? "", env: fixture.env, model: "aimock/aimock-model" });
  try {
    for (const prompt of ["Tool turn", "Next turn"]) {
      const start: number = calls.length;
      const seq = session.records().at(-1)?.seq ?? -1;
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next turn distinguishes a per-prompt reply from a session total.
      const result = await promptAndWait(session, prompt, { timeoutMs: 60_000 });
      assert.ok(result.kind === "ended" && result.outcome.kind === "completed", JSON.stringify(result));
      const frames = session.records().filter(record => record.seq > seq && record.kind === "frame");
      const reply = frames.findLast(record => record.kind === "frame" && record.body.type === "session/prompt");
      assert.ok(reply?.kind === "frame");
      const usage = asRecord(asRecord(reply.body.native)?.usage);
      assert.ok(usage !== null);
      const context = frames.flatMap(record => record.kind === "frame" ? record.body.events.flatMap(event =>
        event.kind === "usage" && event.usage.context !== undefined ? [event.usage.context.tokens] : []) : []);
      const steps: StepUsage[] = calls.slice(start);
      assert.equal(steps.length, prompt === "Tool turn" ? 2 : 1);
      const reported: StepUsage[] = mode === "whole-turn" ? steps : steps.slice(-1);
      const input: number = reported.reduce((sum, step) => sum + step.input_tokens, 0);
      const output: number = reported.reduce((sum, step) => sum + step.output_tokens, 0);
      assert.deepEqual(usage, { inputTokens: input, outputTokens: output, totalTokens: input + output });
      const projected = session.usage().value.total;
      assert.deepEqual(projected, mode === "last-step" ? null : {
        input: calls.reduce((sum, step) => sum + step.input_tokens, 0),
        output: calls.reduce((sum, step) => sum + step.output_tokens, 0),
      });
      console.log(JSON.stringify({ version: installation.version, prompt, steps, usage, context, projected }));
    }
  } finally { await session.dispose(); }
} finally { await fixture.stop(); }
