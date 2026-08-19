import antigravityRuntimeDefinition from "./antigravity.js";
import copilotRuntimeDefinition from "./copilot.js";
import cursorRuntimeDefinition from "./cursor.js";
import geminiRuntimeDefinition from "./gemini.js";
import grokRuntimeDefinition from "./grok.js";
import opencodeRuntimeDefinition from "./opencode.js";

const commandRuntimeDefinitions = {
  antigravity: antigravityRuntimeDefinition,
  copilot: copilotRuntimeDefinition,
  cursor: cursorRuntimeDefinition,
  gemini: geminiRuntimeDefinition,
  grok: grokRuntimeDefinition,
  opencode: opencodeRuntimeDefinition,
};

export default commandRuntimeDefinitions;
