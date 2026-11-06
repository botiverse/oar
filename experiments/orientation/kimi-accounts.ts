/** Build first, then run with OAR_KIMI_LOGIN_COMMAND pointing at Kimi 2.4.1. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeKimiAccountEnvironment } from "../../sea-trial/vendor/support/kimi-account-environment.js";

const result = await probeKimiAccountEnvironment(process.env.OAR_KIMI_LOGIN_COMMAND ?? "kimi", true);
const output = path.resolve(process.argv[2] ?? "oar-trial-run/kimi-account-environment.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
