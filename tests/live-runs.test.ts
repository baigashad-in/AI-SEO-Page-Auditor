// Regression tests for problems found in the third set of live runs
// (react.dev, Substack, Medium, Reddit, tinyfish.ai, Wikipedia).
import { describe, expect, it } from "vitest";
import { blockText, htmlFacts, looksLikeChallenge } from "../lib/parse/html";
import { markdownStats } from "../lib/parse/markdown";
import { robotsVerdicts } from "../lib/parse/robots";
import { buildFindings, buildStrengths } from "../lib/analyze/findings";
import { buildReport } from "../lib/analyze/report";
import { cleanResultUrl } from "../lib/stages/searchStage";
import { looksLikeSitemap } from "../lib/stages/fetchStage";
import type { AgentAnswer, AgentStageResult, BrowserStageResult, FetchStageResult, SearchStageResult } from "../lib/types";

const URL_ = "https://example.com/page";

function fetchStage(md: string, over: Partial<FetchStageResult> = {}): FetchStageResult {
  const v = robotsVerdicts(null, URL_);
  return {
    input: { url: URL_ },
    page: { url: URL_, finalUrl: URL_, title: "Example page", description: "A description", language: "en", author: null, publishedDate: null, markdown: md, links: [], imageLinks: [], latencyMs: 1 },
    pageError: null,
    stats: markdownStats(md),
    robots: { found: true, url: "https://example.com/robots.txt", note: "", verdicts: v.verdicts, sitemaps: [], status: "parsed" },
    llmsTxt: { found: true, url: "", chars: 10 },
    sitemap: { checkedUrl: "https://example.com/sitemap.xml", containsUrl: true, note: "" },
    links: { internal: 1, external: 0 },
    calls: [],
    ...over,
  };
}

function browserStage(html: string, over: Partial<BrowserStageResult> = {}): BrowserStageResult {
  const facts = htmlFacts(html);
  return {
    ok: true,
    requestedUrl: URL_,
    finalUrl: URL_,
    status: 200,
    redirectChain: [],
    headers: { xRobotsTag: null, contentType: "text/html" },
    raw: facts,
    rendered: facts,
    renderedInnerTextWords: facts.words,
    onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
    botProbes: [],
    screenshot: null,
    calls: [],
    ...over,
  };
}

function agent(a: Partial<AgentAnswer>): AgentStageResult {
  return {
    ok: true,
    runId: "r",
    status: "COMPLETED",
    query: "q",
    calls: [],
    answer: {
      answer_found: true,
      answer_summary: "Summary from the agent.",
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

const PAGE = `<html lang="en"><head><title>Example page</title><link rel="canonical" href="${URL_}"><meta name="description" content="d"></head>
<body><nav><a>Sign in</a></nav><main><h1>The Example Blog</h1><span>3.4M followers</span>·<span>5+ editors</span>
<p>Our quick start guide introduces the core concepts that you will use every day when building with the library.</p></main></body></html>`;

describe("text extraction keeps words apart", () => {
  it("adds spaces at block boundaries", () => {
    expect(htmlFacts(PAGE).text).toContain("Sign in The Example Blog 3.4M followers");
  });
  it("reduces noscript markup to its text", () => {
    const t = blockText(null) + htmlFacts('<body><noscript><iframe src="https://gtm"></iframe><style>.x{}</style><div>Turn on JavaScript</div></noscript></body>').text;
    expect(t).toContain("Turn on JavaScript");
    expect(t).not.toContain("iframe");
    expect(t).not.toContain(".x{}");
  });
});

describe("bot challenges are recognised", () => {
  it("detects a challenge served with HTTP 200 and a large script", () => {
    const html = `<html><head><title>Reddit - Prove your humanity</title><script>${"var a=1;".repeat(5000)}</script></head><body>Prove your humanity. Complete the challenge below.</body></html>`;
    expect(looksLikeChallenge(html, 200)).toBe(true);
  });
  it("does not flag a long article that mentions captchas", () => {
    expect(looksLikeChallenge(`<body><p>${"Captcha systems are discussed in this long article. ".repeat(120)}</p></body>`, 200)).toBe(false);
  });
  it("audits the challenge as a block, not as the page", () => {
    const ch = '<html><head><title>Reddit - Prove your humanity</title></head><body>Prove your humanity. Complete the challenge.</body></html>';
    const browser = browserStage(ch, { challenge: { title: "Reddit - Prove your humanity", words: 6 } });
    const b = { fetch: fetchStage("# Real content\n\n" + "Post text here about search. ".repeat(40)), browser, search: null, agent: null, query: "seo", queryDerived: false, url: URL_ };
    const ids = buildFindings(b).map((x) => x.id);
    expect(ids).toContain("access-browser-challenged");
    for (const html of ["access-canonical-missing", "meta-og-missing", "schema-missing", "struct-no-h1"]) expect(ids).not.toContain(html);
    const r = buildReport(b, { url: URL_ });
    expect(r.views.rawWords).toBeNull();
    expect(r.views.blockedNote).toContain("Prove your humanity");
    expect(buildStrengths(b).join(" ")).not.toContain("server HTML");
  });
});

describe("robots.txt and sitemap that come back as challenge pages", () => {
  it("rejects a challenge page as a sitemap", () => {
    expect(looksLikeSitemap("Prove your humanity. Complete the challenge below.", ["https://www.redditinc.com/policies"])).toBe(false);
    expect(looksLikeSitemap("<urlset><url><loc>https://x.com/a</loc></url></urlset>", [])).toBe(true);
  });
  it("does not claim crawlers are allowed when robots.txt was unreadable", () => {
    const f = fetchStage("# T\n\n" + "words ".repeat(400));
    f.robots = { ...f.robots, found: false, status: "unreadable", note: "came back as an HTML page" };
    f.sitemap = { checkedUrl: null, containsUrl: null, note: "" };
    const b = { fetch: f, browser: null, search: null, agent: null, query: "q", queryDerived: false, url: URL_ };
    const ids = buildFindings(b).map((x) => x.id);
    expect(ids).toContain("access-robots-unreadable");
    expect(ids).not.toContain("access-no-sitemap");
    expect(buildStrengths(b).join(" ")).not.toContain("robots.txt allows");
  });
});

describe("agent quotes must be on the page", () => {
  const md = "# Quick Start\n\nOur quick start guide introduces the core concepts that you will use every day when building with the library.";
  it("ignores a paraphrased quote instead of reporting a hidden answer", () => {
    const b = { fetch: fetchStage(md), browser: browserStage(PAGE), search: null, query: "learn", queryDerived: false, url: URL_, agent: agent({ evidence_quote: "This guide gives you everything you need to start learning the library and its main ideas today." }) };
    const ids = buildFindings(b).map((x) => x.id);
    expect(ids).not.toContain("answer-hidden");
    expect(buildReport(b, { url: URL_ }).connection.join(" ")).toContain("paraphrased");
  });
  it("still reports a real quote that crawlers do not receive", () => {
    const raw = htmlFacts("<html><body><div id=root></div></body></html>");
    const browser = browserStage(PAGE, { raw });
    const b = { fetch: fetchStage("# Nav only\n\nMenu items."), browser, search: null, query: "learn", queryDerived: false, url: URL_, agent: agent({ evidence_quote: "Our quick start guide introduces the core concepts that you will use every day when building with the library." }) };
    const hidden = buildFindings(b).find((x) => x.id === "answer-hidden");
    expect(hidden?.severity).toBe("high");
  });
  it("still reports an answer revealed by a click, at low confidence", () => {
    const b = { fetch: fetchStage(md), browser: browserStage(PAGE), search: null, query: "refund", queryDerived: false, url: URL_, agent: agent({ answer_location: "after_interaction", interactions_needed: ["Clicked the Refund tab"], evidence_quote: "You get a full refund within 30 days of purchase, no questions asked." }) };
    const hidden = buildFindings(b).find((x) => x.id === "answer-hidden")!;
    expect(hidden.severity).toBe("medium");
    expect(hidden.confidence).toBe("low");
  });
  it("treats a blocked agent as blocked, not as missing content", () => {
    const blockedAgent = agent({
      answer_found: false,
      answer_summary: "The page content could not be accessed because network security blocked the request.",
      blockers: [{ type: "other", description: "Network security blocked access, showing a block message." }],
      missing_information: ["Description of the community"],
    });
    const b = { fetch: fetchStage("# T\n\n" + "Some text about the topic here. ".repeat(10), { page: { ...fetchStage("").page!, description: null } }), browser: null, search: null, query: "seo subreddit", queryDerived: false, url: URL_, agent: blockedAgent };
    const findings = buildFindings(b);
    const blocked = findings.find((x) => x.id === "answer-blocked")!;
    expect(blocked.title).toContain("a block page");
    expect(findings.map((x) => x.id)).not.toContain("answer-not-found");
    expect(JSON.stringify(findings)).not.toContain("Add: Description");
    expect(findings.find((x) => x.id === "meta-description-missing")?.fix.code ?? "").not.toContain("could not be accessed");
  });
});

describe("search results and visibility", () => {
  it("unwraps Google redirect links", () => {
    expect(cleanResultUrl("/url?opi=1&q=https://newsletter.pricingsaas.com/&sa=U")).toBe("https://newsletter.pricingsaas.com/");
    expect(cleanResultUrl("https://react.dev/learn")).toBe("https://react.dev/learn");
  });
  const search = (pos: number | null, urls: string[]): SearchStageResult => ({
    query: "web agent api",
    queryDerived: false,
    location: "US",
    results: urls.map((u, i) => ({ position: i + 1, title: "t", url: u, snippet: "", siteName: "" })),
    pagesChecked: 1,
    target: { position: pos, matchedUrl: null, serpTitle: null, serpSnippet: null },
    domain: { bestPosition: urls.findIndex((u) => u.includes("example.com")) + 1 || null, urls: urls.map((u, i) => ({ position: i + 1, url: u })).filter((x) => x.url.includes("example.com")) },
    indexProbe: { query: "", found: true, position: 1, domainUrls: [] },
    competitors: [],
    calls: [],
  });
  it("does not call a page visible when only another URL of the site ranks", () => {
    const b = { fetch: fetchStage("# T\n\n" + "Words about web agents. ".repeat(60)), browser: browserStage(PAGE), search: search(null, ["https://a.com", "https://example.com/blog/post", "https://b.com"]), agent: null, query: "web agent api", queryDerived: false, url: URL_ };
    const r = buildReport(b, { url: URL_ });
    expect(r.scores.quadrant).toBe("readable_invisible");
    expect(r.connection.join(" ")).toContain("Another page on the same site ranks #2");
  });
  it("names a domain that owns the results", () => {
    const b = { fetch: fetchStage("# T\n\nShort."), browser: null, search: search(null, ["https://news.brand.com/", "https://brand.com/a", "https://brand.com/b", "https://c.com", "https://d.com"]), agent: null, query: "brand newsletter", queryDerived: false, url: URL_ };
    const f = buildFindings(b).find((x) => x.id === "vis-not-ranking")!;
    expect(f.fix.steps[0]).toContain("3 of the top 5 results are on brand.com");
  });
  it("shows query words as typed, not as stems", () => {
    const b = { fetch: fetchStage("# PricingSaaS\n\nPricingSaaS tracks pricing pages."), browser: null, search: null, agent: null, query: "pricingsaas newsletter", queryDerived: false, url: URL_ };
    const f = buildFindings(b).find((x) => x.id === "content-query-terms-missing")!;
    expect(f.evidence.join(" ")).toContain("Found: pricingsaas.");
  });
});
