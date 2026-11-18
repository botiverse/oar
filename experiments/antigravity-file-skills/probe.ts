import { resolve } from "node:path";
import { compareAntigravityFileSkills } from "../../sea-trial/vendor/support/antigravity-file-skills.js";

await compareAntigravityFileSkills(resolve(process.argv[2] ?? "oar-trial-run/antigravity-file-skills/comparison.json"));
