// Runs a full audit in one process (used by the CLI and demo script).
// The web UI runs the same stages through API routes so each request stays short.

import type { AuditInput, AuditReport } from "./types";
import { runFetchStage } from "./stages/fetchStage";
import { runBrowserStage } from "./stages/browserStage";
import { runSearchStage } from "./stages/searchStage";
import { runAgentStage } from "./stages/agentStage";
import { buildReport } from "./analyze/report";
import { pageSignals, resolveQuery } from "./analyze/query";
import { parseInputUrl } from "./url";
import { agentSummary, browserSummary, fetchSummary, searchSummary, track } from "./progress";

export interface RunOptions {
  skipBrowser?: boolean;
  skipAgent?: boolean;
  onProgress?: (msg: string) => void;
}

export async function runFullAudit(input: AuditInput, opts: RunOptions = {}): Promise<AuditReport> {
  const log = opts.onProgress ?? (() => {});
  const url = parseInputUrl(input.url).toString();
  const inp = { ...input, url };

  log("Fetch + Browser: reading the live page");
  const [fetch, browser] = await Promise.all([
    track("Fetch", () => runFetchStage(inp), log, { summary: fetchSummary }),
    opts.skipBrowser ? Promise.resolve(null) : track("Browser", () => runBrowserStage(inp), log, { summary: browserSummary }),
  ]);

  const { query, derived } = resolveQuery(inp, fetch, browser);
  log(`Query: "${query}"${derived ? " (derived from the page)" : ""}`);

  log("Search + Agent: visibility and answerability");
  const [search, agent] = await Promise.all([
    track("Search", () => runSearchStage({ url, query, queryDerived: derived, location: input.location, ...pageSignals(fetch, browser) }), log, {
      summary: searchSummary,
    }),
    opts.skipAgent
      ? Promise.resolve(null)
      : track("Agent", () => runAgentStage(url, query, undefined, (status) => log(`Agent: ${status.toLowerCase()}`)), log, { summary: agentSummary }),
  ]);

  return buildReport({ fetch, browser, search, agent, query, queryDerived: derived, url }, inp);
}
