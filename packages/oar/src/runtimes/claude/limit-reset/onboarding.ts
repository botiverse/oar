/** Exact Claude Code 2.1.322 and 2.1.332 onboarding pages, recorded against local backends.
 * Only whitespace and the welcome banner's version vary. All choices, preview
 * text and notice text must remain present, with no additional content.
 */
const INTRO = "Welcome to Claude Code VERSION .......................................................... * █████▓▓░ * ███▓░ ░░ ░░░░░░ ███▓░ ░░░ ░░░░░░░░░░ ███▓░ ░░░░░░░░░░░░░░░░░░░ * ██▓░░ ▓ ░▓▓███▓▓░ * ░░░░ ░░░░░░░░ ░░░░░░░░░░░░░░░░ █████████ * ██▄█████▄██ * █████████ * .......█ █ █ █..........................................";
const THEME_HEADER = "Let's get started. Choose the text style that looks best with your terminal To change this later, run /theme";
const THEME_TAIL = "Light mode Dark mode (colorblind-friendly) Light mode (colorblind-friendly) Dark mode (ANSI colors only) Light mode (ANSI colors only) ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ 1 function greet() { 2 - console.log(\"Hello, World!\"); 2 + console.log(\"Hello, Claude!\"); 3 } ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ Syntax theme: Monokai Extended (ctrl+t to disable)";
const THEMES = [
  `${THEME_HEADER} Auto (match terminal) ❯ ✔ Dark mode ${THEME_TAIL}`,
  `${THEME_HEADER} ❯ ✔ Auto (match terminal) Dark mode ${THEME_TAIL}`,
];
const SECURITY_BODY = "Security notes: 1. Claude can make mistakes. You're responsible for Claude's actions and should always review them, especially when running code. 2. Due to prompt injection risks, only use it with code you trust Learn more: https://code.claude.com/docs/en/security";
const SECURITIES = [
  `${SECURITY_BODY} Press Enter to continue…`,
  `${SECURITY_BODY} Press Enter to continue`,
];

export type ClaudeOnboardingScreen = "theme" | "security" | "unrecognised";

/** A recognisable onboarding frame is not permission to act on its contents. */
export function onboardingScreen(screen: string): ClaudeOnboardingScreen | null {
  if (!screen.includes("Welcome to Claude Code") && !screen.includes("Choose the text style")
    && !screen.includes("Security notes:")) { return null; }
  const normalized = screen.trim().replaceAll(/\s+/gu, " ")
    .replace(/^Welcome to Claude Code v\d+\.\d+\.\d+ /u, "Welcome to Claude Code VERSION ");
  if (THEMES.some((theme) => normalized === `${INTRO} ${theme}`)) { return "theme"; }
  if (SECURITIES.some((security) => normalized === `${INTRO} ${security}`)) { return "security"; }
  return "unrecognised";
}
