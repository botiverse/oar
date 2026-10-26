/**
 * Write one private environment snapshot for userShellEnvironment's capture
 * subprocess. The host routes its subcommand here with OAR's final marker
 * argument and lets stdout drain before exiting. Never call it in the parent
 * application: the snapshot contains credentials.
 */
export function writeShellEnvironmentCapture(marker: string): void {
  process.stdout.write(marker + JSON.stringify(process.env) + marker);
}
