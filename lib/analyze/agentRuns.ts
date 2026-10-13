// Several agent runs on the same page and question, merged into one stage result. Pure, so the CLI
// (server) and the web app (browser) merge the same way. Which run the report shows is decided later,
// with the page data at hand, by chooseAgentRun in findings.ts.

import type { AgentStageResult } from "../types";

/** One result holding every run. A single run is returned as it is. */
export function mergeAgentRuns(results: AgentStageResult[]): AgentStageResult {
  if (results.length === 1) return results[0];
  const n = results.length;
  const first = results.find((r) => r.ok) ?? results[0];
  const errors = [...new Set(results.map((r) => r.error).filter((e): e is string => !!e))];
  return {
    ...first,
    error: first.ok ? first.error : errors.join("; ") || first.error,
    // "Start answerability run 2 of 3", so the call log tells the runs apart.
    calls: results.flatMap((r, i) => r.calls.map((c) => ({ ...c, purpose: c.purpose.replace(/^(Start answerability run|Answerability run)/, `$1 ${i + 1} of ${n}`) }))),
    runs: results.map(({ ok, runId, status, error, numSteps, answer }) => ({ ok, runId, status, error, numSteps: numSteps ?? null, answer })),
  };
}
