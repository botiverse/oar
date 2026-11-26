import { claudeModelRequestRefusal, claudeRefusedSessionOptions } from "./options.js";
/* oxlint-disable import/max-dependencies -- The runtime declaration imports one module per capability. */
import { semverAtLeast } from "../../shared/semver.js";
import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { claudeCommands, claudeSkills, claudeMcpServers, claudeTools } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { claudeAuthStatus, claudeLogin } from "./login.js";
import { claudeLogout } from "./logout.js";
import { claudeCredentials } from "./credentials.js";
import { claudeAccountUsage } from "./account-usage.js";
import { claudeInspectLimitResets, claudeRedeemLimitReset } from "./limit-reset/index.js";
import { claudeInstallation } from "./installation.js";
import { claudeInstall, claudeInstallPlan } from "./install.js";
import { claudeListModels } from "./list-models.js";
import { claudeCheckUpdate, claudeUpgrade } from "./update.js";
import { claudeSideQuestion, supportsClaudeSideQuestion } from "./side-question.js";
import { claudeUserQuestionRefusal } from "./user-questions.js";
import { claudeSession } from "./session.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  sideQuestion: claudeSideQuestion,
  sessionCapabilities: (installation) => ({
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.1.292")
      ? { taskEventTypes: semverAtLeast(installation.version, "2.1.318") ? ["agent", "shell", "workflow"] : ["workflow"] } : {}),
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.1.326") ? { subagentResults: { foreground: "parent_tool_result", background: "child_text" } } : {}),
    ...(supportsClaudeSideQuestion(installation) ? { sideQuestion: true } : {}),
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.1.284") ? { questions: true } : {}),
    refusedSessionOptions: {
      ...claudeModelRequestRefusal(installation.via === "executable" ? installation.version : undefined),
      ...claudeUserQuestionRefusal(installation.via === "executable" ? installation.version : undefined),
    },
    steer: true, images: true, contextUsage: { tokens: true, contextWindow: true }, mcpTransports: ["stdio", "http"], stopTask: true,
  }),
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  refusedSessionOptions: claudeRefusedSessionOptions,
  resumedSessionOptions: {
    systemPrompt: { provided: "next_compaction", omitted: "saved_until_compaction" },
    appendSystemPrompt: { provided: "next_compaction", omitted: "saved_until_compaction" },
  },
  credentials: claudeCredentials,
  brand: runtimeBrands.claude, verifiedPlatforms: verifiedPlatforms.claude,
  skills: claudeSkills,
  commands: claudeCommands,
  mcpServers: claudeMcpServers,
  tools: claudeTools,
  mcpToolsListChanged: "additions",

  installation: claudeInstallation,
  installPlan: claudeInstallPlan,
  install: claudeInstall,
  accountUsage: claudeAccountUsage,
  inspectLimitResets: claudeInspectLimitResets,
  redeemLimitReset: claudeRedeemLimitReset,
  listModels: claudeListModels,
  checkUpdate: claudeCheckUpdate,
  upgrade: claudeUpgrade,
  login: claudeLogin,
  logout: claudeLogout,
  authStatus: claudeAuthStatus,
  session: claudeSession,
}, { execution: "process" });
