// Stage 4: TinyFish Agent. Can an AI browsing agent answer the searcher's question from this page?
// This is the only stage that interacts with the page (dismiss pop-ups, open tabs and accordions),
// so it finds answers hidden behind clicks and blockers that Fetch, Browser and Search cannot see.
// The report then checks whether the agent's evidence quote is also in the Fetch extraction and in
// the raw server HTML, which tells the site owner exactly which kind of AI tool can or cannot use it.

import type { AgentAnswer, AgentStageResult, AnswerLocation, CallLog } from "../types";
import { tfCancelAgentRun, tfGetAgentRun, tfStartAgentRun, tinyfishErrorText } from "../tinyfish";
import { parseInputUrl } from "../url";
import { mergeAgentRuns } from "../analyze/agentRuns";

const LOCATIONS: AnswerLocation[] = ["visible_on_load", "after_scroll", "after_interaction", "other_page", "not_on_page"];
// "banner" and "block_page" were added 2026-10-13: without them the agent filed a top banner under
// modal, cookie_wall or other, and a "you have been blocked" page under login_wall or other.
const BLOCKERS = ["cookie_wall", "modal", "banner", "login_wall", "paywall", "captcha", "block_page", "age_gate", "region_block", "broken_page", "other"];

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer_found: { type: "boolean" },
    answer_summary: { type: "string", nullable: true },
    evidence_quote: { type: "string", nullable: true },
    answer_location: { type: "string", enum: LOCATIONS },
    interactions_needed: { type: "array", items: { type: "string" }, maxItems: 10 },
    blockers: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: { type: { type: "string", enum: BLOCKERS }, description: { type: "string" }, got_in_the_way: { type: "boolean" } },
        required: ["type", "description", "got_in_the_way"],
      },
    },
    page_purpose: { type: "string" },
    missing_information: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
  required: [
    "answer_found",
    "answer_summary",
    "evidence_quote",
    "answer_location",
    "interactions_needed",
    "blockers",
    "page_purpose",
    "missing_information",
  ],
};

export function agentGoal(url: string, query: string): string {
  const host = new URL(url).host;
  return [
    "You are testing how well an AI assistant that browses the web could answer a searcher's question using only this page.",
    `Question: "${query}"`,
    "Rules:",
    `1. Stay on this exact page (${url}). Do not open other pages, even on ${host}, and do not use search engines or other websites.`,
    "2. You may scroll, close cookie or newsletter pop-ups, and click tabs, accordions, 'read more' or 'show more' controls on this page.",
    "3. Do not log in, sign up, buy anything, or submit any form.",
    "Report:",
    "- answer_found: true only if this page itself answers the question.",
    "- answer_summary: the answer in one or two sentences, or null.",
    "- evidence_quote: copy one exact sentence from the page that supports the answer (40 words max), or null.",
    "- answer_location: visible_on_load if the answer is readable without scrolling or clicking; after_scroll if you only had to scroll; after_interaction only if a click was needed to reveal the answer (opening a tab, accordion or 'read more', or closing something that covered the answer); other_page if this page only links to the answer; not_on_page if absent. Closing a banner or pop-up that did not cover the answer does not make it after_interaction.",
    "- interactions_needed: each click or dismissal you needed to reach the answer, in order.",
    "- blockers: everything that covered, interrupted or replaced the content, even if you got past it. type: cookie_wall (cookie consent), modal (a pop-up or dialog over the page), banner (a bar or strip at the top or bottom of the page), login_wall (sign-in needed to see the content), paywall, captcha (a check that you are human), block_page (an 'access denied' or 'you have been blocked' page instead of the content), age_gate, region_block, broken_page (an error page or a page that did not load), other. description: one short sentence. got_in_the_way: true if it covered or replaced content you needed or you had to close or get past it; false if it was only there and did not get in your way.",
    "- page_purpose: one sentence on what the page is for.",
    "- missing_information: up to 5 specific facts someone asking this question would still need that the page does not give.",
  ].join("\n");
}

// Countries TinyFish's agent proxy supports (docs.tinyfish.ai/key-concepts/proxies).
const PROXY_COUNTRIES = ["US", "GB", "CA", "DE", "FR", "JP", "AU"];

/**
 * Every agent run goes out from the audit's country (default US, the same country as the Search
 * check), so runs do not differ by where the agent happened to connect from. A country TinyFish's
 * proxy does not cover gets no proxy rather than a different country.
 */
export function agentProxy(location?: string): { enabled: boolean; country_code?: string } | undefined {
  const country = (location || "US").trim().toUpperCase();
  return PROXY_COUNTRIES.includes(country) ? { enabled: true, country_code: country } : undefined;
}

export async function startAgentStage(url: string, query: string, location?: string): Promise<{ runId: string | null; error?: string; calls: CallLog[] }> {
  const pageUrl = parseInputUrl(url).toString();
  const t = Date.now();
  try {
    // The standard ("lite") browser on purpose: the audit measures what ordinary AI agents meet, and
    // the anti-detection "stealth" browser would get past blocks those agents hit.
    const res = await tfStartAgentRun({
      url: pageUrl,
      goal: agentGoal(pageUrl, query),
      output_schema: AGENT_OUTPUT_SCHEMA,
      browser_profile: "lite",
      proxy_config: agentProxy(location),
    });
    if (!res.run_id) {
      const msg = tinyfishErrorText(res.error?.message || "No run_id returned", "an Agent run");
      return { runId: null, error: msg, calls: [{ endpoint: "agent", purpose: "Start answerability run", ms: Date.now() - t, ok: false, detail: msg }] };
    }
    return { runId: res.run_id, calls: [{ endpoint: "agent", purpose: "Start answerability run (run-async)", ms: Date.now() - t, ok: true, detail: res.run_id }] };
  } catch (err) {
    const msg = tinyfishErrorText(err, "an Agent run");
    return { runId: null, error: msg, calls: [{ endpoint: "agent", purpose: "Start answerability run", ms: Date.now() - t, ok: false, detail: msg }] };
  }
}

function asStringArray(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()).slice(0, max) : [];
}

/** Accepts the run result whether it is the schema object, wrapped in another key, or a JSON string. */
export function normalizeAgentResult(result: unknown): AgentAnswer | null {
  let r: unknown = result;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (r && typeof r === "object" && !("answer_found" in (r as object))) {
    const inner = Object.values(r as object).find((v) => v && typeof v === "object" && "answer_found" in (v as object));
    if (inner) r = inner;
  }
  if (!r || typeof r !== "object" || !("answer_found" in (r as object))) return null;
  const o = r as Record<string, unknown>;
  const loc = LOCATIONS.includes(o.answer_location as AnswerLocation) ? (o.answer_location as AnswerLocation) : o.answer_found ? "visible_on_load" : "not_on_page";
  const blockers = Array.isArray(o.blockers)
    ? (o.blockers as unknown[])
        .filter((b) => b && typeof b === "object")
        .map((b) => {
          const o = b as Record<string, unknown>;
          const x: AgentAnswer["blockers"][number] = { type: String(o.type ?? "other"), description: String(o.description ?? "") };
          if (typeof o.got_in_the_way === "boolean") x.got_in_the_way = o.got_in_the_way;
          return x;
        })
        .slice(0, 8)
    : [];
  return {
    answer_found: Boolean(o.answer_found),
    answer_summary: typeof o.answer_summary === "string" && o.answer_summary.trim() ? o.answer_summary.trim() : null,
    evidence_quote: typeof o.evidence_quote === "string" && o.evidence_quote.trim() ? o.evidence_quote.trim() : null,
    answer_location: loc,
    interactions_needed: asStringArray(o.interactions_needed, 10),
    blockers,
    page_purpose: typeof o.page_purpose === "string" ? o.page_purpose : "",
    missing_information: asStringArray(o.missing_information, 5),
  };
}

export async function pollAgentStage(runId: string, query: string): Promise<AgentStageResult> {
  const t = Date.now();
  try {
    const run = await tfGetAgentRun(runId);
    const calls: CallLog[] = [];
    const done = run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED";
    if (done) {
      calls.push({ endpoint: "agent", purpose: "Answerability run result", ms: Date.now() - t, ok: run.status === "COMPLETED", detail: `${run.status}, ${run.num_of_steps ?? "?"} steps` });
    }
    const answer = run.status === "COMPLETED" ? normalizeAgentResult(run.result ?? run.resultJson) : null;
    const errText = run.error ? tinyfishErrorText([run.error.message, run.error.help_message].filter(Boolean).join(" "), "the Agent run") : "";
    return {
      ok: run.status === "COMPLETED" && !!answer,
      runId,
      status: run.status,
      error: errText || (run.status === "COMPLETED" && !answer ? "Run completed but result did not match the schema" : undefined),
      numSteps: run.num_of_steps,
      query,
      answer,
      calls,
    };
  } catch (err) {
    return { ok: false, runId, status: "ERROR", error: tinyfishErrorText(err, "the Agent run result"), query, answer: null, calls: [] };
  }
}

/**
 * How many times the agent runs per audit: AGENT_RUNS (1 to 5), default 3. The agent is an AI model,
 * so one run can differ from the next, and some sites block some visits and not others; several runs
 * show how often each result happens. Each run costs TinyFish credits, so 3 runs cost 3 times as much.
 */
export function agentRunCount(value = process.env.AGENT_RUNS): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}

export interface StartedRun {
  runId: string | null;
  error?: string;
  calls: CallLog[];
}

/** Starts the same check `count` times, one call after another. The runs then work in parallel. */
export async function startAgentRuns(url: string, query: string, location?: string, count = agentRunCount()): Promise<StartedRun[]> {
  const out: StartedRun[] = [];
  for (let i = 0; i < count; i++) out.push(await startAgentStage(url, query, location));
  return out;
}

/** The stage result for a run that never started. */
export function notStarted(s: StartedRun, query: string): AgentStageResult {
  return { ok: false, runId: null, status: "NOT_STARTED", error: s.error, query, answer: null, calls: s.calls };
}

/** Poll one started run until it finishes, or cancel it at the deadline. */
async function waitForRun(s: StartedRun & { runId: string }, query: string, deadline: number, timeoutMs: number, onStatus?: (status: string) => void): Promise<AgentStageResult> {
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await pollAgentStage(s.runId, query);
    if (onStatus && res.status !== last) onStatus(res.status);
    last = res.status;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(res.status)) return { ...res, calls: [...s.calls, ...res.calls] };
  }
  await tfCancelAgentRun(s.runId);
  return {
    ok: false,
    runId: s.runId,
    status: "TIMEOUT",
    error: `Agent run did not finish in ${Math.round(timeoutMs / 1000)}s and was cancelled.`,
    query,
    answer: null,
    calls: [...s.calls, { endpoint: "agent", purpose: "Answerability run", ms: timeoutMs, ok: false, detail: "timed out, cancelled" }],
  };
}

/** Server-side helper for the CLI: start the runs, poll each until done or timeout, cancel on timeout, merge. */
export async function runAgentStage(
  url: string,
  query: string,
  opts: { timeoutMs?: number; onStatus?: (status: string) => void; location?: string; count?: number } = {},
): Promise<AgentStageResult> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const started = await startAgentRuns(url, query, opts.location, opts.count ?? agentRunCount());
  const deadline = Date.now() + timeoutMs;
  const n = started.length;
  const results = await Promise.all(
    started.map((s, i) =>
      s.runId
        ? waitForRun({ ...s, runId: s.runId }, query, deadline, timeoutMs, opts.onStatus && ((status) => opts.onStatus!(n > 1 ? `${status} (run ${i + 1} of ${n})` : status)))
        : Promise.resolve(notStarted(s, query)),
    ),
  );
  return mergeAgentRuns(results);
}
