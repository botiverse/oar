/** Two native queued inputs become one reply; retain both reported identities. */
import { claudeMergedIdentity } from "../../sea-trial/vendor/support/claude-merged-identity.js";

console.log(JSON.stringify(await claudeMergedIdentity(), null, 2));
