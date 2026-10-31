import { acpDiagnosticSummary } from "../../shared/acp/diagnostic-summary.js";

export const openCodeDiagnosticSummary = (report?: Parameters<typeof acpDiagnosticSummary>[1]): ReturnType<typeof acpDiagnosticSummary> => acpDiagnosticSummary("opencode", report);
