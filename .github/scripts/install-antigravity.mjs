// Keep the shared entry used by ordinary CI and manual evidence workflows.
// Archive URLs and hashes are the accepted Antigravity entry in the version table.
import { installRuntime } from "./runtime-install.mjs";
const result = await installRuntime("antigravity-aimock");
process.stdout.write(`Verified agy CLI ${result.actualVersion}\n`);
