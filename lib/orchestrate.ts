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
  const [fetch, browser] = await Promise.all([runFetchStage(inp), opts.skipBrowser ? Promise.resolve(null) : runBrowserStage(inp)]);
  log(`Fetch: ${fetch.page ? `${fetch.stats?.words ?? 0} words extracted` : `failed (${fetch.pageError?.error})`}`);
  if (browser) log(`Browser: ${!browser.ok ? `failed (${browser.error})` : browser.challenge ? "got a bot challenge page" : browser.rawChallenge ? "first HTML response was a bot challenge; the browser got through" : `raw ${browser.raw?.words} words, rendered ${browser.rendered?.words} words`}`);

  const { query, derived } = resolveQuery(inp, fetch, browser);
  log(`Query: "${query}"${derived ? " (derived from the page)" : ""}`);

  log("Search + Agent: visibility and answerability");
  const [search, agent] = await Promise.all([
    runSearchStage({
      url,
      query,
      queryDerived: derived,
      location: input.location,
      ...pageSignals(fetch, browser),
    }),
    opts.skipAgent ? Promise.resolve(null) : runAgentStage(url, query),
  ]);
  log(`Search: ${search.target.position ? `#${search.target.position}` : "not in top results"}`);
  if (agent) log(`Agent: ${agent.ok ? (agent.answer?.answer_found ? "answered" : "no answer") : agent.error}`);

  return buildReport({ fetch, browser, search, agent, query, queryDerived: derived, url }, inp);
}
