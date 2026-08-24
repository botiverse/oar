export const SAY_ENV_NAME = "OAR_SAY";

function sayInvocation(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `& "$env:${SAY_ENV_NAME}"`
    : `"$${SAY_ENV_NAME}"`;
}

export function sayProtocol(platform: NodeJS.Platform = process.platform): string {
  const invocation = sayInvocation(platform);
  return `Coxswain delivery protocol:
The human-facing conversation accepts only messages delivered through the Coxswain CLI. Returning a reply as raw assistant text fails the task because raw text is diagnostic activity and is not delivered.
\`${SAY_ENV_NAME}\` points to a trusted executable created by the Coxswain host.
Before completing any turn with a reply or progress update, you MUST directly run \`${invocation} "your message"\`.
After that command exits successfully, do not repeat the delivered message as assistant text.
Do not inspect, print, resolve, or replace \`${SAY_ENV_NAME}\`. Do not run bare \`say\`: on macOS that resolves to the system speech command.`;
}
