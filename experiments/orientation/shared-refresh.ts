/** Two native processes share synthetic credentials; no real account or model. */
import assert from "node:assert/strict";
import { activeRefresh, simultaneousRefresh } from "../../sea-trial/vendor/support/orientation/shared-refresh.js";

const command = process.env.OAR_CLAUDE_BIN;
assert.ok(command !== undefined && command !== "", "Set OAR_CLAUDE_BIN to the real Claude binary");
await simultaneousRefresh(command);
await activeRefresh(command);
