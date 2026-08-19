import claudeRuntimeDefinition from "./claude.js";
import codexRuntimeDefinition from "./codex.js";
import kimiCliRuntimeDefinition from "./kimi-cli.js";

const specialRuntimeDefinitions = {
  claude: claudeRuntimeDefinition,
  codex: codexRuntimeDefinition,
  kimiCli: kimiCliRuntimeDefinition,
};

export default specialRuntimeDefinitions;
