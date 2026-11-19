/** Through OAR: systemPrompt and appendSystemPrompt on OpenCode 2.x, for a new session, its resume and a custom default agent. */
import assert from "node:assert/strict";
import { opencodeRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

const [variant = "default"] = process.argv.slice(2);
const resumeAppend = process.env.PROBE_RESUME_APPEND;
const installation = await opencodeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable", "Set OAR_OPENCODE_BIN to the selected binary");
const requests: { readonly system: string; readonly updates: string }[] = [];
const user = variant === "custom"
  ? { default_agent: "review", agents: { review: { mode: "primary", description: "Custom review agent", system: "USER-REVIEW-PROMPT" }, plan: { disabled: true } } }
  : {};
const fixture = await startOpencodeAimock(mock => {
  mock.on({ predicate: request => (request.tools ?? []).length > 0 }, request => {
    requests.push({
      system: JSON.stringify(request.messages.filter(message => message.role === "system")),
      updates: JSON.stringify(request.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("system-update"))),
    });
    return { content: "Complete" };
  });
}, user);
function report(label: string): Record<string, unknown> {
  const last = requests.at(-1) ?? { system: "", updates: "" };
  return { label, system1: last.system.includes("SYSTEM-ONE"), system2: last.system.includes("SYSTEM-TWO"), append: last.system.includes("APPEND-ONE"),
    userReviewPrompt: last.system.includes("USER-REVIEW-PROMPT"), builtIn: /You are opencode|You are OpenCode/u.test(last.system), updates: last.updates.slice(0, 300) };
}
const base = { cwd: fixture.env.HOME ?? "", env: fixture.env, model: "aimock/aimock-model" };
try {
  const first = await opencodeRuntime.session(installation, { ...base, systemPrompt: "SYSTEM-ONE", appendSystemPrompt: "APPEND-ONE" });
  const { id } = first;
  try {
    const result = await promptAndWait(first, "Say done", { timeoutMs: 60_000 });
    assert.ok(result.kind === "ended" && result.outcome.kind === "completed", JSON.stringify(result));
    console.log(JSON.stringify({ version: installation.version, variant, ...report("new") }));
  } finally { await first.dispose(); }
  const resumed = await opencodeRuntime.session(installation, { ...base, resume: id, systemPrompt: "SYSTEM-TWO", ...(resumeAppend === undefined ? {} : { appendSystemPrompt: resumeAppend }) });
  try {
    const result = await promptAndWait(resumed, "Say done again", { timeoutMs: 60_000 });
    assert.ok(result.kind === "ended" && result.outcome.kind === "completed", JSON.stringify(result));
    console.log(JSON.stringify({ version: installation.version, variant, ...report("resume") }));
  } finally { await resumed.dispose(); }
} finally { await fixture.stop(); }
