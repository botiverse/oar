/** Private native status versus a synthetic custom-provider key, with no real account. */
import { writeFile } from "node:fs/promises";
import { codebuddyAccountControl } from "../../packages/oar/src/runtimes/codebuddy/account-control.js";
import { codebuddyInstallation } from "../../packages/oar/src/runtimes/codebuddy/installation.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startCodebuddyAimock } from "../../sea-trial/harness/codebuddy-aimock.js";

const installation = await codebuddyInstallation();
if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("CodeBuddy is unavailable"); }
const fixture = await startCodebuddyAimock();
const control = codebuddyAccountControl(installation.command, sessionEnvironment(fixture.env));
const timer = setTimeout(() => { control.process.stop(); }, 20_000);
try {
  const response = await control.request({ subtype: "initialize" });
  const accountShape = asRecord(response.account) === null ? "absent" : "object";
  const evidence = {
    version: installation.version,
    syntheticEnvironmentKey: true,
    localEndpoint: true,
    nativeAccount: response.account === null ? "null" : accountShape,
  };
  const output = process.env.OAR_PROBE_OUTPUT;
  if (output !== undefined) { await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }
  console.log(JSON.stringify(evidence));
} finally { clearTimeout(timer); control.process.stop(); await control.process.exited; await fixture.stop(); }
