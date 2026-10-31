import type { AcpUnattributed } from "../../shared/acp/routing.js";

interface DiagnosticSummary {
  readonly kind: "connection_diagnostics";
  readonly frames: number;
  readonly reasons: Partial<Record<AcpUnattributed["reason"], number>>;
}

/** At most one count-only summary per 30 seconds across this Runtime instance's pool. */
export function openCodeDiagnosticSummary(report: (summary: DiagnosticSummary) => void = (summary) => {
  console.error("[oar:opencode:shared]", JSON.stringify(summary));
}): (entry: AcpUnattributed) => void {
  let reasons: DiagnosticSummary["reasons"] = {};
  let frames = 0;
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    const summary: DiagnosticSummary = { kind: "connection_diagnostics", frames, reasons };
    frames = 0; reasons = {}; last = Date.now();
    try { report(summary); } catch { /* Diagnostics cannot fail the session or host timer. */ }
  };
  return (entry) => {
    frames++;
    reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
    const remaining = last + 30_000 - Date.now();
    if (remaining <= 0 && timer === null) { flush(); }
    else if (timer === null) { timer = setTimeout(flush, remaining); timer.unref(); }
  };
}
