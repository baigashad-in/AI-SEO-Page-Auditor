// Builders for stage results shared by the test files. Each returns a small, realistic result that a
// test overrides field by field.
import { htmlFacts } from "../lib/parse/html";
import { markdownStats } from "../lib/parse/markdown";
import { robotsVerdicts } from "../lib/parse/robots";
import type { StageBundle } from "../lib/analyze/findings";
import type { AgentAnswer, AgentStageResult, BrowserStageResult, FetchStageResult, FetchedPage, SearchStageResult } from "../lib/types";

export const PAGE_URL = "https://example.com/page";
export const REDDIT_URL = "https://www.reddit.com/r/SEO/";

function origin(url: string): string {
  return new URL(url).origin;
}

export function fetchStage(md: string, over: Partial<FetchStageResult> = {}, url = PAGE_URL, page: Partial<FetchedPage> = {}): FetchStageResult {
  return {
    input: { url },
    page: { url, finalUrl: url, title: "Example page", description: "A description", language: "en", author: null, publishedDate: null, markdown: md, links: [], imageLinks: [], latencyMs: 1, ...page },
    pageError: null,
    stats: markdownStats(md),
    robots: { found: true, url: `${origin(url)}/robots.txt`, note: "", verdicts: robotsVerdicts(null, url).verdicts, sitemaps: [], status: "parsed" },
    llmsTxt: { found: true, url: "", chars: 10 },
    sitemap: { checkedUrl: `${origin(url)}/sitemap.xml`, containsUrl: true, note: "" },
    links: { internal: 1, external: 0 },
    calls: [],
    ...over,
  };
}

export function browserStage(rawHtml: string, renderedHtml = rawHtml, over: Partial<BrowserStageResult> = {}, url = PAGE_URL): BrowserStageResult {
  const raw = htmlFacts(rawHtml);
  const rendered = htmlFacts(renderedHtml);
  return {
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    redirectChain: [],
    headers: { xRobotsTag: null, contentType: "text/html" },
    raw,
    rendered,
    renderedInnerTextWords: rendered.words,
    onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
    botProbes: [],
    screenshot: null,
    calls: [],
    ...over,
  };
}

export function search(position: number | null, over: Partial<SearchStageResult> = {}, url = PAGE_URL, query = "q"): SearchStageResult {
  return {
    query,
    queryDerived: false,
    location: "US",
    results: [],
    pagesChecked: 1,
    target: { position, matchedUrl: position ? url : null, serpTitle: null, serpSnippet: null },
    domain: { bestPosition: position, urls: [] },
    indexProbe: { query: "", found: true, position: 1, domainUrls: [] },
    competitors: [],
    calls: [],
    ...over,
  };
}

export function agent(a: Partial<AgentAnswer>): AgentStageResult {
  return {
    ok: true,
    runId: "r",
    status: "COMPLETED",
    query: "q",
    calls: [],
    answer: {
      answer_found: true,
      answer_summary: "Summary.",
      evidence_quote: null,
      answer_location: "visible_on_load",
      interactions_needed: [],
      blockers: [],
      page_purpose: "A page",
      missing_information: [],
      ...a,
    },
  };
}

export function bundle(over: Partial<StageBundle>, url = PAGE_URL, query = "q"): StageBundle {
  return { fetch: null, browser: null, search: null, agent: null, query, queryDerived: false, url, ...over };
}

/** Text long enough to count as a real page (well over the 400-word challenge limit). */
export const LONG_TEXT = "Search engine optimization is the practice of improving how pages appear in search results. ".repeat(80);
