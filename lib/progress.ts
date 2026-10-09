// Live progress for long stages, printed to the terminal by the CLI, the batch demo and the web
// app's API routes. A stage can take minutes (Browser loads the page and probes it as four crawlers;
// the Agent reads and clicks), so a "still running" line every 15 seconds shows it is not stuck.

import type { AgentStageResult, BrowserStageResult, FetchStageResult, SearchStageResult } from "./types";

export const HEARTBEAT_MS = 15_000;

function secs(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

/** Logs "started", a "still running" line every heartbeat, and "done" or "failed" for one stage. */
export async function track<T>(
  label: string,
  work: () => Promise<T>,
  log: (msg: string) => void,
  opts: { subject?: string; summary?: (r: T) => string; everyMs?: number } = {},
): Promise<T> {
  const t0 = Date.now();
  log(`${label}: started${opts.subject ? ` (${opts.subject})` : ""}`);
  const timer = setInterval(() => log(`${label}: still running (${Math.round((Date.now() - t0) / 1000)}s)`), opts.everyMs ?? HEARTBEAT_MS);
  try {
    const r = await work();
    log(`${label}: done in ${secs(t0)}${opts.summary ? `, ${opts.summary(r)}` : ""}`);
    return r;
  } catch (err) {
    log(`${label}: failed after ${secs(t0)} (${(err as Error).message})`);
    throw err;
  } finally {
    clearInterval(timer);
  }
}

export function fetchSummary(r: FetchStageResult): string {
  if (!r.page) return `page not read (${r.pageError?.error ?? "unknown error"})`;
  return `${r.stats?.words ?? 0} words extracted, robots.txt ${r.robots.status ?? (r.robots.found ? "parsed" : "not found")}`;
}

export function browserSummary(r: BrowserStageResult): string {
  if (!r.ok) return `failed (${r.error})`;
  if (r.challenge) return `got a bot challenge page (${r.challenge.reason ?? "challenge"})`;
  if (r.rawChallenge) return `first HTML response was a bot challenge; rendered ${r.rendered?.words} words`;
  return `raw ${r.raw?.words} words, rendered ${r.rendered?.words} words, ${r.botProbes.length} crawler probes`;
}

export function searchSummary(r: SearchStageResult): string {
  return r.target.position ? `#${r.target.position} for "${r.query}"` : `not in top ${r.pagesChecked * 10} for "${r.query}"`;
}

export function agentSummary(r: AgentStageResult): string {
  if (!r.ok) return `${r.status}: ${r.error ?? "no result"}`;
  return r.answer?.answer_found ? "answer found" : "no answer on the page";
}

/** Prefix for lines the web app's API routes print, so they stand out from Next.js request lines. */
export function serverLog(msg: string): void {
  console.log(`[audit] ${msg}`);
}
