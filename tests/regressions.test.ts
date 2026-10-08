// Regression tests for bugs found in the first live TinyFish run (Wikipedia SEO article).
import { describe, expect, it } from "vitest";
import { htmlFacts } from "../lib/parse/html";
import { markdownToPlain, markdownStats as markdownStatsFor } from "../lib/parse/markdown";
import { buildFindings, suggestDescription, topicGaps } from "../lib/analyze/findings";
import { buildReport } from "../lib/analyze/report";
import { termCounts } from "../lib/analyze/text";
import type { BrowserStageResult } from "../lib/types";

const head = `<html lang="en"><head><title>T</title>
<meta name="Description" content="A real description">
<meta name="ROBOTS" content="noindex, follow">
<meta name="googlebot" content="nosnippet">
<meta property="og:title" content="OG title"><meta property="og:description" content="OG desc">
<meta property="og:type" content="article"><meta property="og:image" content="https://x.com/a.png">
</head><body><main><h1>Hello</h1><p>Body text here.</p></main></body></html>`;

describe("head values are read before the head is stripped", () => {
  const f = htmlFacts(head);
  it("reads meta description case-insensitively", () => expect(f.metaDescription).toBe("A real description"));
  it("combines robots and googlebot directives", () => expect(f.metaRobots).toBe("noindex, follow, nosnippet"));
  it("reads Open Graph tags", () => {
    expect(f.og).toEqual({ title: "OG title", description: "OG desc", type: "article", image: "https://x.com/a.png" });
  });
  it("still excludes head text from the body word count", () => expect(f.text).not.toContain("OG title"));
});

describe("noindex in meta robots now produces a critical finding", () => {
  const raw = htmlFacts(head);
  const browser: BrowserStageResult = {
    ok: true,
    requestedUrl: "https://x.com/p",
    finalUrl: "https://x.com/p",
    status: 200,
    redirectChain: [],
    headers: { xRobotsTag: null, contentType: "text/html" },
    raw,
    rendered: raw,
    renderedInnerTextWords: raw.words,
    onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
    botProbes: [],
    screenshot: null,
    calls: [],
  };
  const findings = buildFindings({ fetch: null, browser, search: null, agent: null, query: "hello", queryDerived: false, url: "https://x.com/p" });
  it("flags noindex and nosnippet", () => {
    expect(findings.find((x) => x.id === "access-noindex")?.severity).toBe("critical");
    expect(findings.map((x) => x.id)).toContain("access-nosnippet");
  });
  it("does not claim Open Graph tags are missing", () => expect(findings.map((x) => x.id)).not.toContain("meta-og-missing"));
});

describe("drafted descriptions skip boilerplate", () => {
  const md = [
    "From Wikipedia, the free encyclopedia",
    "",
    "Practice and strategies of increasing online visibility",
    "",
    '"SEO" redirects here. For other uses, see Seo (disambiguation).',
    "",
    "| This article has multiple issues. Please help improve it. |",
    "",
    "Search engine optimization is the practice of improving how websites appear in unpaid search results so that more people find them.",
  ].join("\n");
  it("uses the first real paragraph", () => {
    expect(suggestDescription(md, "Search engine optimization")).toMatch(/^Search engine optimization is the practice/);
  });
  it("prefers the agent's direct answer when there is one", () => {
    expect(suggestDescription(md, null, "SEO is the practice of improving visibility in unpaid search results for a query.")).toMatch(/^SEO is the practice/);
  });
  it("keeps drafts within 155 characters", () => {
    expect(suggestDescription(md, null, "word ".repeat(80)).length).toBeLessThanOrEqual(155);
  });
});

describe("topic gaps are specific", () => {
  const compText = (extra: string) =>
    `Use Google Search Console to check indexing. Search Console shows search results data. ${extra}. Improve the user experience. Search Console again. Search results again.`;
  const comps = [
    { url: "https://developers.google.com/x", title: "SEO Starter Guide | Google Search Central", terms: termCounts(compText("Create helpful content")), headings: ["Search Console basics"] },
    { url: "https://searchengineland.com/y", title: "What Is SEO - Search Engine Optimization?", terms: termCounts(compText("Make it easy to know")), headings: ["Using Search Console"] },
  ];
  it("reports a missing phrase even when its words appear separately", () => {
    const gaps = topicGaps("We talk about search engines and a game console here.", comps).map(([t]) => t);
    expect(gaps).toContain("search console");
  });
  it("does not report generic words or brand names", () => {
    const gaps = topicGaps("Short page.", comps).map(([t]) => t);
    for (const junk of ["create", "helpful", "know", "make", "google search", "google"]) expect(gaps).not.toContain(junk);
  });
  it("reports nothing when the page already covers the phrases", () => {
    expect(topicGaps("Search Console data, search results and the user experience are covered here.", comps)).toEqual([]);
  });
});

describe("report polish", () => {
  it("strips table separator runs left inside flattened tables", () => {
    const sep = "-".repeat(3);
    expect(markdownToPlain(`| a | | ${sep} | ${sep} | | b |`)).not.toContain(sep);
  });
  it("keeps low and info findings out of Do today", () => {
    const r = buildReport({ fetch: null, browser: null, search: null, agent: null, query: "q", queryDerived: true, url: "https://x.com" }, { url: "https://x.com" });
    for (const id of r.doToday) {
      const f = r.findings.find((x) => x.id === id)!;
      expect(["critical", "high", "medium"]).toContain(f.severity);
    }
  });
});

describe("second live run: react.dev and Wikipedia", () => {
  const comp = (n: string, pos: number) => ({
    url: `https://${n}.com/x`,
    position: pos,
    title: `${n} course`,
    fetched: true,
    stats: { words: 900, headings: [{ level: 2, text: "Certificate course" }], h1Count: 1, listItems: 9, tableRows: 4, paragraphs: 9, firstWords: "" },
    terms: termCounts("Earn a certificate course. Certificate course again. Certificate course."),
  });
  const search = (pos: number | null) => ({
    query: "learn react",
    queryDerived: false,
    location: "US",
    results: [],
    pagesChecked: 1,
    target: { position: pos, matchedUrl: null, serpTitle: null, serpSnippet: null },
    domain: { bestPosition: pos, urls: [] },
    indexProbe: { query: "", found: true, position: 1, domainUrls: [] },
    competitors: [comp("alpha", 2), comp("beta", 3), comp("gamma", 4)],
    calls: [],
  });
  const md = "# Quick Start\n\nWelcome to the React documentation. This page introduces the concepts you will use every day.";
  const fetch = {
    input: { url: "https://react.dev/learn" },
    page: { url: "https://react.dev/learn", finalUrl: "https://react.dev/learn", title: "Quick Start", description: "d", language: "en", author: null, publishedDate: null, markdown: md, links: [], imageLinks: [], latencyMs: 1 },
    pageError: null,
    stats: markdownStatsFor(md),
    robots: { found: true, url: "", note: "", verdicts: [], sitemaps: [] },
    llmsTxt: { found: true, url: "", chars: 10 },
    sitemap: { checkedUrl: "x", containsUrl: true, note: "" },
    links: { internal: 1, external: 0 },
    calls: [],
  };
  it("does not compare a #1 page with pages ranked below it", () => {
    const ids = buildFindings({ fetch, browser: null, search: search(1) as never, agent: null, query: "learn react", queryDerived: false, url: "https://react.dev/learn" }).map((x) => x.id);
    expect(ids).not.toContain("gap-terms");
    expect(ids).not.toContain("gap-depth");
  });
  it("still compares an unranked page with the top results", () => {
    const ids = buildFindings({ fetch, browser: null, search: search(null) as never, agent: null, query: "learn react", queryDerived: false, url: "https://react.dev/learn" }).map((x) => x.id);
    expect(ids).toContain("gap-depth");
  });
  it("does not lower readability for a blocked training crawler", () => {
    const facts = htmlFacts("<html><head><title>T</title></head><body><main><h1>H</h1><p>Some words here for the page.</p></main></body></html>");
    const browser = (verdictFor: Record<string, "ok" | "blocked">): BrowserStageResult => ({
      ok: true, requestedUrl: "https://x.com", finalUrl: "https://x.com", status: 200, redirectChain: [],
      headers: { xRobotsTag: null, contentType: "text/html" }, raw: facts, rendered: facts, renderedInnerTextWords: facts.words,
      onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
      botProbes: Object.entries(verdictFor).map(([bot, verdict]) => ({ bot, userAgent: "x", status: verdict === "ok" ? 200 : 403, words: 5, challenge: verdict !== "ok", verdict })),
      screenshot: null, calls: [],
    });
    const base = { fetch: null, search: null, agent: null, query: "q", queryDerived: false, url: "https://x.com" };
    const ok = buildReport({ ...base, browser: browser({ "OAI-SearchBot": "ok", ClaudeBot: "ok" }) }, { url: "https://x.com" }).scores.readability;
    const training = buildReport({ ...base, browser: browser({ "OAI-SearchBot": "ok", ClaudeBot: "blocked" }) }, { url: "https://x.com" }).scores.readability;
    const searchBlocked = buildReport({ ...base, browser: browser({ "OAI-SearchBot": "blocked", ClaudeBot: "ok" }) }, { url: "https://x.com" }).scores.readability;
    expect(training).toBe(ok);
    expect(searchBlocked).toBeLessThan(ok);
  });
  it("rates missing WebPage markup as low", () => {
    const facts = htmlFacts("<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Reference text for developers.</p></main></body></html>");
    const browser: BrowserStageResult = {
      ok: true, requestedUrl: "https://x.com/docs", finalUrl: "https://x.com/docs", status: 200, redirectChain: [],
      headers: { xRobotsTag: null, contentType: "text/html" }, raw: facts, rendered: facts, renderedInnerTextWords: facts.words,
      onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
      botProbes: [], screenshot: null, calls: [],
    };
    const f = buildFindings({ fetch: null, browser, search: null, agent: null, query: "docs", queryDerived: false, url: "https://x.com/docs" });
    expect(f.find((x) => x.id === "schema-missing")?.severity).toBe("low");
  });
});
