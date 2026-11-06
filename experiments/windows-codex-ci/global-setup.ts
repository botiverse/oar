import { availableParallelism, totalmem } from "node:os";
import setup from "../../sea-trial/global-setup.js";
import { codexPhaseRecord, startCodexPhase } from "../../sea-trial/harness/codex-phases.js";

export default function prepare(): void {
  codexPhaseRecord("global_setup_entered", { availableParallelism: availableParallelism(), totalMemoryBytes: totalmem() });
  const prepared = startCodexPhase("global.process_table");
  try { setup(); prepared({ outcome: "completed" }); }
  catch (error) { prepared({ outcome: "threw" }); throw error; }
}
