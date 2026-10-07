import { describe, expect, it } from "vitest";
import { buildFindings, topicGaps, suggestDescription } from "../lib/analyze/findings";
import { computeScores } from "../lib/analyze/report";
import { normalizeAgentResult } from "../lib/stages/agentStage";
import { htmlFacts } from "../lib/parse/html";
import { markdownStats } from "../lib/parse/markdown";
import { robotsVerdicts } from "../lib/parse/robots";
import { termCounts } from "../lib/analyze/text";
import type { BrowserStageResult, FetchStageResult, SearchStageResult } from "../lib/types";

const URL_ = "https://acme.com/pricing";

function fetchStage(md: string, robots: string | null): FetchStageResult {
  const v = robotsVerdicts(robots, URL_);
  return {
    input: { url: URL_ },
    page: { url: URL_, finalUrl: URL_, title: "Pricing | Acme", description: null, language: "en", author: null, publishedDate: null, markdown: md, links: [], imageLinks: [], latencyMs: 100 },
    pageError: null,
    stats: markdownStats(md),
    robots: { found: robots !== null, url: "https://acme.com/robots.txt", note: "", verdicts: v.verdicts, sitemaps: v.sitemaps },
    llmsTxt: { found: false, url: "https://acme.com/llms.txt", chars: 0 },
    sitemap: { checkedUrl: "https://acme.com/sitemap.xml", containsUrl: false, note: "not listed" },
    links: { internal: 3, external: 0 },
    calls: [],
  };
}

function browserStage(rawHtml: string, renderedHtml: string): BrowserStageResult {
  const raw = htmlFacts(rawHtml);
  const rendered = htmlFacts(renderedHtml);
  return {
    ok: true,
    requestedUrl: URL_,
    finalUrl: URL_,
    status: 200,
    redirectChain: [],
    headers: { xRobotsTag: null, contentType: "text/html" },
    raw,
    rendered,
    renderedInnerTextWords: rendered.words,
    onlyAfterJs: { headings: ["Plans"], title: false, description: false, canonical: !raw.canonical && !!rendered.canonical, h1: raw.h1.length === 0 && rendered.h1.length > 0, jsonLd: false },
    botProbes: [
      { bot: "OAI-SearchBot", userAgent: "x", status: 200, words: 3, challenge: false, verdict: "ok" },
      { bot: "ClaudeBot", userAgent: "x", status: 403, words: 2, challenge: true, verdict: "blocked" },
    ],
    screenshot: null,
    calls: [],
  };
}

const body = Array.from({ length: 30 }, (_, i) => `Sentence ${i} about plans that cost money per user every month for small teams.`).join(" ");
const renderedHtml = `<html lang="en"><head><title>Pricing | Acme</title><link rel="canonical" href="${URL_}"></head><body><div id="root"><main><h1>Acme pricing</h1><h2>Plans</h2><p>${body}</p></main></div></body></html>`;
const rawHtml = `<html><head><title>Pricing | Acme</title><script src="/static/js/main.abc123.js"></script></head><body><div id="root"></div></body></html>`;

describe("findings on a client-rendered page", () => {
  const robots = "User-agent: OAI-SearchBot\nDisallow: /pricing\n\nUser-agent: GPTBot\nDisallow: /";
  const f = fetchStage(`# Acme pricing\n\n${body}`, robots);
  const br = browserStage(rawHtml, renderedHtml);
  const findings = buildFindings({ fetch: f, browser: br, search: null, agent: null, query: "acme pricing per user", queryDerived: false, url: URL_ });
  const ids = findings.map((x) => x.id);

  it("flags JavaScript-only content as critical", () => {
    const js = findings.find((x) => x.id === "render-js-dependent-content")!;
    expect(js.severity).toBe("critical");
    expect(js.evidence.join(" ")).toContain("Raw server HTML: 0 words");
    expect(js.fix.steps[0]).toContain("Client-only React");
  });
  it("flags robots blocks for AI search but only notes training blocks", () => {
    expect(ids).toContain("access-robots-search-blocked");
    expect(findings.find((x) => x.id === "access-robots-training-blocked")!.severity).toBe("info");
    const rb = findings.find((x) => x.id === "access-robots-search-blocked")!;
    expect(rb.fix.code).toContain("Allow: /pricing");
  });
  it("flags edge blocking and late canonical/h1", () => {
    expect(ids).toContain("access-edge-blocks-ai-bots");
    expect(findings.find((x) => x.id === "render-tags-js-only")!.title).toContain("canonical");
  });
  it("drafts a meta description from the page's own text", () => {
    const d = findings.find((x) => x.id === "meta-description-missing")!;
    expect(d.fix.code).toContain("Sentence 0 about plans");
  });
  it("sorts critical first", () => {
    expect(findings[0].severity).toBe("critical");
  });
  it("scores readability low and skips visibility without search", () => {
    const s = computeScores({ fetch: f, browser: br, search: null, agent: null, query: "q", queryDerived: false, url: URL_ });
    expect(s.readability).toBeLessThan(60);
    expect(s.visibility).toBeNull();
    expect(s.quadrant).toBe("unknown");
  });
});

describe("visibility and gaps", () => {
  const md = "# Acme pricing\n\nPlans cost eight dollars per user each month for small teams who track projects.";
  const comp = (n: string) =>
    termCounts(`${n} pricing per seat. Start a free trial today. Annual billing gives a discount. Money back guarantee on all plans. Annual billing saves money. Free trial for 14 days. Money back guarantee applies.`);
  const search: SearchStageResult = {
    query: "acme pricing",
    queryDerived: false,
    location: "US",
    results: [
      { position: 1, title: "A", url: "https://planwise.com/pricing", snippet: "", siteName: "planwise.com" },
      { position: 2, title: "B", url: "https://acme.com/about", snippet: "", siteName: "acme.com" },
    ],
    pagesChecked: 2,
    target: { position: null, matchedUrl: null, serpTitle: null, serpSnippet: null },
    domain: { bestPosition: 2, urls: [{ position: 2, url: "https://acme.com/about" }] },
    indexProbe: { query: "Pricing | Acme", found: false, position: null, domainUrls: ["https://acme.com/about"] },
    competitors: ["planwise", "taskly", "boardly"].map((n, i) => ({
      url: `https://${n}.com/pricing`,
      position: i + 1,
      title: `${n} pricing`,
      fetched: true,
      stats: markdownStats(`# ${n}\n\n${"word ".repeat(900)}`),
      terms: comp(n),
    })),
    calls: [],
  };
  const f = fetchStage(md, null);
  const findings = buildFindings({ fetch: f, browser: null, search, agent: null, query: "acme pricing", queryDerived: false, url: URL_ });

  it("detects cannibalization and index probe miss", () => {
    expect(findings.find((x) => x.id === "vis-not-ranking")!.title).toContain("different URL");
    expect(findings.map((x) => x.id)).toContain("vis-index-probe");
  });
  it("merges overlapping bigrams into phrases and avoids cross-word junk", () => {
    const gaps = topicGaps(md, search.competitors.map((c) => ({ url: c.url, title: c.title, terms: c.terms }))).map(([t]) => t);
    expect(gaps).toContain("money back guarantee");
    expect(gaps).toContain("annual billing");
    expect(gaps).toContain("free trial");
    expect(gaps).not.toContain("start free");
    expect(gaps.some((g) => g.includes("planwise"))).toBe(false);
  });
  it("reports depth gap", () => {
    expect(findings.map((x) => x.id)).toContain("gap-depth");
  });
});

describe("agent result normalization", () => {
  it("accepts wrapped and string results", () => {
    const r = { answer_found: true, answer_summary: "x", evidence_quote: "q", answer_location: "after_interaction", interactions_needed: [], blockers: [], page_purpose: "p", missing_information: [] };
    expect(normalizeAgentResult(r)!.answer_location).toBe("after_interaction");
    expect(normalizeAgentResult({ output: r })!.answer_found).toBe(true);
    expect(normalizeAgentResult(JSON.stringify(r))!.evidence_quote).toBe("q");
    expect(normalizeAgentResult({ foo: 1 })).toBeNull();
  });
  it("drafts descriptions under 160 chars", () => {
    expect(suggestDescription("# T\n\n" + body, "T").length).toBeLessThanOrEqual(160);
  });
});
