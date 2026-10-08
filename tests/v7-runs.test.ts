// Regression tests for problems found in the fourth set of live runs (v6 on Wikipedia, react.dev,
// Medium, Substack, Reddit and tinyfish.ai). Page content here is synthetic, shaped like what those
// runs returned.
import { describe, expect, it, vi } from "vitest";
import { challengeReason, htmlFacts, looksLikeChallenge } from "../lib/parse/html";
import { markdownStats } from "../lib/parse/markdown";
import { parseRobots, reflowRobots, robotsVerdicts } from "../lib/parse/robots";
import { buildFindings, pageCasing, type StageBundle } from "../lib/analyze/findings";
import { buildReport, domainList } from "../lib/analyze/report";
import { withBrowserRobots } from "../lib/analyze/robotsSource";
import { pageSignals } from "../lib/analyze/query";
import { quoteAppearsIn } from "../lib/analyze/text";
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

function browserStage(rawHtml: string, renderedHtml = rawHtml, over: Partial<BrowserStageResult> = {}): BrowserStageResult {
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
    onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
    botProbes: [],
    screenshot: null,
    calls: [],
    ...over,
  };
}

function search(position: number | null, over: Partial<SearchStageResult> = {}): SearchStageResult {
  return {
    query: "q",
    queryDerived: false,
    location: "US",
    results: [],
    pagesChecked: 1,
    target: { position, matchedUrl: position ? URL_ : null, serpTitle: null, serpSnippet: null },
    domain: { bestPosition: position, urls: [] },
    indexProbe: { query: "", found: true, position: 1, domainUrls: [] },
    competitors: [],
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

function bundle(over: Partial<StageBundle>): StageBundle {
  return { fetch: null, browser: null, search: null, agent: null, query: "q", queryDerived: false, url: URL_, ...over };
}

const LONG_TEXT = "Search engine optimization is the practice of improving how pages appear in search results. ".repeat(80);

describe("bot challenge detection looks at what the reader sees, on the whole page", () => {
  it("does not flag a long article whose <head> mentions captcha in a script (Wikipedia)", () => {
    const html = `<html><head><script>var cfg={"wgConfirmEditCaptchaNeeded":true};${"/*x*/".repeat(15000)}</script>
      <title>Search engine optimization - Wikipedia</title></head><body><nav>Main menu</nav><p>${LONG_TEXT}</p></body></html>`;
    expect(html.indexOf("<body")).toBeGreaterThan(60_000);
    expect(looksLikeChallenge(html, 200)).toBe(false);
  });

  it("does not flag a short JavaScript app shell that loads Cloudflare's detection script (Medium)", () => {
    const html = `<html><head><title>Medium</title><script src="https://www.google.com/recaptcha/api.js"></script></head>
      <body><nav>Sitemap Open in app Sign up Sign in</nav><h2>The Medium Blog</h2><p>3.4M followers</p>
      <script>(function(){var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script></body></html>`;
    expect(htmlFacts(html).words).toBeLessThan(400);
    expect(looksLikeChallenge(html, 200)).toBe(false);
  });

  it("flags a challenge whose title sits after a large inline style, with entities in the text (Reddit)", () => {
    const html = `<html><head><style>${".a{color:red}".repeat(8000)}</style><title>Reddit - Prove your humanity</title></head>
      <body><h1>Prove&nbsp;your humanity</h1><p>We&#8217;re committed to safety and security. But not for bots.</p></body></html>`;
    expect(html.indexOf("<title>")).toBeGreaterThan(60_000);
    expect(looksLikeChallenge(html, 200)).toBe(true);
    expect(challengeReason(htmlFacts(html), html, 200)).toContain("prove your humanity");
  });

  it("flags challenge markup even when the text is neutral", () => {
    expect(looksLikeChallenge('<html><body><p>One moment</p><script>window._cf_chl_opt={cType:"managed"}</script></body></html>', 200)).toBe(true);
  });

  it("does not flag a short sign-in page that says it is protected by reCAPTCHA", () => {
    expect(looksLikeChallenge("<html><body><form>Email Password Sign in</form><p>This site is protected by reCAPTCHA.</p></body></html>", 200)).toBe(false);
  });

  it("uses the status code only for short responses", () => {
    expect(challengeReason({ title: null, text: "Forbidden", words: 1 }, "", 403)).toBe("HTTP 403");
    expect(challengeReason({ title: null, text: LONG_TEXT, words: 1200 }, "", 403)).toBeNull();
  });
});

describe("a challenge in the first HTML response that the browser gets past", () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>';
  const real = `<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${LONG_TEXT}</p></main></body></html>`;
  const br = browserStage(challenge, real, { rawChallenge: { title: "Just a moment...", words: 4, reason: 'the page says "just a moment"' } });
  const b = bundle({ fetch: fetchStage(`# Guide\n\n${LONG_TEXT}`), browser: br });

  it("is reported as a crawler block, not as JavaScript-only content", () => {
    const ids = buildFindings(b).map((f) => f.id);
    expect(ids).toContain("access-raw-challenge");
    expect(ids).not.toContain("render-js-dependent-content");
  });

  it("does not show the challenge's word count as the raw HTML count", () => {
    const r = buildReport(b, { url: URL_ });
    expect(r.views.rawWords).toBeNull();
    expect(r.views.renderedWords).toBeGreaterThan(400);
    expect(r.connection.join(" ")).toContain("first HTML response is a bot challenge");
  });
});

describe("robots.txt with lost line breaks", () => {
  const joinedWithComments =
    "# Welcome to our robots.txt # We believe in an open internet, but not the misuse of public content. # See https://example.com/policy for details. User-agent: * Disallow: /";
  const joinedRules = "User-Agent: * Disallow: /m/ Disallow: /me/ Allow: /blog Sitemap: https://example.com/sitemap/sitemap.xml";

  it("restores rules hidden behind a joined comment header", () => {
    const v = robotsVerdicts(joinedWithComments, URL_);
    expect(v.reflowed).toBe(true);
    expect(v.validLines).toBe(2);
    expect(v.verdicts.find((x) => x.bot.token === "OAI-SearchBot")?.allowed).toBe(false);
  });

  it("restores a joined rule list instead of reading one user-agent called '* disallow: /m/ ...'", () => {
    const v = robotsVerdicts(joinedRules, "https://example.com/m/settings");
    expect(v.reflowed).toBe(true);
    expect(v.sitemaps).toEqual(["https://example.com/sitemap/sitemap.xml"]);
    expect(v.verdicts.find((x) => x.bot.token === "OAI-SearchBot")?.allowed).toBe(false);
    expect(robotsVerdicts(joinedRules, "https://example.com/blog").verdicts.every((x) => x.allowed)).toBe(true);
  });

  it("leaves a normal file alone, including commented-out rules", () => {
    const txt = "User-agent: *\nDisallow: /private\n# Disallow: /old\n";
    expect(reflowRobots(txt).reflowed).toBe(false);
    expect(robotsVerdicts(txt, "https://example.com/old").verdicts.every((x) => x.allowed)).toBe(true);
    expect(parseRobots("# User-agent: *\n# Disallow: /").validLines).toBe(0);
  });

  it("reads lines that markdown turned into list items", () => {
    expect(robotsVerdicts("- User-agent: *\n- Disallow: /x", "https://example.com/x").verdicts[0].allowed).toBe(false);
  });

  it("shows what came back when robots.txt could not be parsed", () => {
    const f = fetchStage("# Page\n\ntext", {
      robots: { found: false, url: "https://example.com/robots.txt", note: "robots.txt has no valid directives. Crawler rules unknown.", verdicts: robotsVerdicts(null, URL_).verdicts, sitemaps: [], status: "unreadable", excerpt: "Something unexpected" },
    });
    const finding = buildFindings(bundle({ fetch: f })).find((x) => x.id === "access-robots-unreadable")!;
    expect(finding.evidence.join(" ")).toContain('What came back starts with: "Something unexpected"');
  });
});

describe("robots.txt read as plain text through the browser", () => {
  const unreadable = () =>
    fetchStage("# Page\n\ntext", {
      robots: { found: false, url: "https://example.com/robots.txt", note: "x", verdicts: robotsVerdicts(null, URL_).verdicts, sitemaps: [], status: "unreadable" },
      sitemap: { checkedUrl: null, containsUrl: null, note: "No /sitemap.xml, and robots.txt could not be read to look for a declared sitemap." },
    });
  const plain = (text: string, over: Partial<NonNullable<BrowserStageResult["robotsTxt"]>> = {}) =>
    browserStage("<html><body><p>hi</p></body></html>", undefined, {
      robotsTxt: { url: "https://example.com/robots.txt", status: 200, contentType: "text/plain", text, ...over },
    });

  it("replaces an unreadable Fetch copy and fills in a declared sitemap", () => {
    const b = withBrowserRobots(bundle({ fetch: unreadable(), browser: plain("User-agent: OAI-SearchBot\nDisallow: /\n\nSitemap: https://example.com/sm.xml\n") }));
    expect(b.fetch!.robots.status).toBe("parsed");
    expect(b.fetch!.robots.source).toBe("browser");
    expect(b.fetch!.robots.note).toContain("TinyFish Browser");
    expect(b.fetch!.robots.verdicts.find((x) => x.bot.token === "OAI-SearchBot")?.allowed).toBe(false);
    expect(b.fetch!.sitemap.checkedUrl).toBe("https://example.com/sm.xml");
    expect(buildFindings(b).map((f) => f.id)).not.toContain("access-no-sitemap");
  });

  it("wins over a Fetch copy that parsed to a different answer", () => {
    const f = fetchStage("# Page\n\ntext");
    const b = withBrowserRobots(bundle({ fetch: f, browser: plain("User-agent: *\nDisallow: /") }));
    expect(b.fetch!.robots.note).toContain("gave different results");
    expect(b.fetch!.robots.verdicts.every((x) => !x.allowed)).toBe(true);
  });

  it("is ignored when the browser also got a challenge page", () => {
    const fetch = unreadable();
    const b = withBrowserRobots(bundle({ fetch, browser: plain("<html><title>Just a moment...</title></html>", { contentType: "text/html" }) }));
    expect(b.fetch!.robots.status).toBe("unreadable");
  });

  it("turns a 404 into 'no robots.txt' when Fetch could not tell", () => {
    const b = withBrowserRobots(bundle({ fetch: unreadable(), browser: plain("Not found", { status: 404 }) }));
    expect(b.fetch!.robots.status).toBe("absent");
  });
});

describe("severity follows the evidence from the v6 runs", () => {
  it("rates a query word that is in the title, on a page ranking #2, as low (Medium)", () => {
    const f = fetchStage("Here is what stood out at our annual event and other news.", { page: { ...fetchStage("").page!, title: "The Medium Blog", markdown: "Here is what stood out at our annual event and other news." } });
    const b = bundle({ fetch: f, search: search(2), query: "medium blog" });
    const finding = buildFindings(b).find((x) => x.id === "content-query-terms-missing")!;
    expect(finding.severity).toBe("low");
    expect(finding.title).toContain("only in the title or description");
  });

  it("keeps it high when the word is nowhere and the page does not rank (Substack)", () => {
    const md = "John Kotowski. CEO and co-founder of PricingSaaS. Good Better Best. 10K+ subscribers.";
    const b = bundle({ fetch: fetchStage(md, { page: { ...fetchStage("").page!, title: "John Kotowski | Substack", description: null, markdown: md } }), search: search(null), query: "pricingsaas newsletter" });
    expect(buildFindings(b).find((x) => x.id === "content-query-terms-missing")!.severity).toBe("high");
  });

  it("does not call a page thin as 'high' when the pages that rank have even less text", () => {
    const md = "word ".repeat(46);
    const comps = [33, 28, 162].map((w, i) => ({ url: `https://other.com/${i}`, position: i + 1, title: "t", fetched: true, terms: {}, stats: markdownStats("word ".repeat(w)) }));
    const b = bundle({ fetch: fetchStage(md), search: search(null, { competitors: comps }) });
    const finding = buildFindings(b).find((x) => x.id === "extract-thin")!;
    expect(finding.severity).toBe("medium");
    expect(finding.evidence.join(" ")).toContain("competing pages are thin too");
  });

  it("rates 61 JavaScript-only words as medium, not high", () => {
    const raw = `<html><body><p>${"word ".repeat(46)}</p></body></html>`;
    const ren = `<html><body><p>${"word ".repeat(46)}</p><p>${"later ".repeat(61)}</p></body></html>`;
    const finding = buildFindings(bundle({ fetch: fetchStage("x"), browser: browserStage(raw, ren) })).find((x) => x.id === "render-js-dependent-content")!;
    expect(finding.severity).toBe("medium");
  });

  it("still rates a large JavaScript-only gap as critical", () => {
    const raw = `<html><body><p>${"word ".repeat(49)}</p></body></html>`;
    const ren = `<html><body><p>${"word ".repeat(49)}</p><p>${"later ".repeat(1780)}</p></body></html>`;
    expect(buildFindings(bundle({ fetch: fetchStage("x"), browser: browserStage(raw, ren) })).find((x) => x.id === "render-js-dependent-content")!.severity).toBe("critical");
  });

  it("says 'no headings' instead of 'only 0 heading(s)'", () => {
    const md = "word ".repeat(679);
    expect(buildFindings(bundle({ fetch: fetchStage(md) })).find((x) => x.id === "struct-wall-of-text")!.title).toBe("679 extracted words and no headings");
  });

  it("rates a banner the agent dismissed before answering on load as low (tinyfish.ai)", () => {
    const a = agent({ blockers: [{ type: "modal", description: "Promotional banner at the top of the page" }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blockers")!.severity).toBe("low");
    const notFound = agent({ answer_found: false, blockers: [{ type: "modal", description: "Newsletter pop-up" }] });
    expect(buildFindings(bundle({ agent: notFound })).find((x) => x.id === "answer-blockers")!.severity).toBe("medium");
  });
});

describe("wording taken from the page", () => {
  it("writes query words the way the page writes them", () => {
    expect(pageCasing("pricingsaas newsletter", ["@pricingsaas · CEO and co-founder of PricingSaaS."])).toBe("PricingSaaS Newsletter");
    expect(pageCasing("learn react", ["LEARN REACT Describing the UI. React apps are made of components."])).toBe("Learn React");
    expect(pageCasing("seo subreddit", ["Reddit's No.1 SEO Community"])).toBe("SEO Subreddit");
  });

  it("names a domain once with a page count", () => {
    expect(domainList(["https://pricingsaas.com/a", "https://www.pricingsaas.com/b", "https://pricingsaas.com/c", "https://en.wikipedia.org/x"])).toBe("pricingsaas.com (3 pages), wikipedia.org");
  });
});

describe("agent quotes with small edits still match the page", () => {
  const raw = "Sign up Sign in The Medium Blog 3.4M followers· 5+ editors Product News Latest Newsletter Get the best of Medium";
  it("matches a quote with an added label (Medium)", () => {
    expect(quoteAppearsIn("The Medium Blog: 3.4M followers, 5+ editors. Available sections: Product News, Latest, Newsletter.", raw)).toBe(true);
  });
  it("still rejects a paraphrase in different words (react.dev)", () => {
    const text = "Welcome to the React documentation! This page will give you an introduction to 80% of the React concepts that you will use on a daily basis.";
    expect(quoteAppearsIn("This Quick Start guide provides all you need to start learning React: 80% of what you'll use in your daily React development.", text)).toBe(false);
  });
});

describe("search inputs ignore a challenge page's title", () => {
  it("uses the Fetch title when the browser was challenged (Reddit)", () => {
    const br = browserStage("<html><head><title>Reddit - Prove your humanity</title></head><body>Prove your humanity</body></html>", undefined, {
      challenge: { title: "Reddit - Prove your humanity", words: 3 },
    });
    const f = fetchStage("text", { page: { ...fetchStage("").page!, title: "r/SEO" } });
    expect(pageSignals(f, br).pageTitle).toBe("r/SEO");
  });
});

vi.mock("../lib/tinyfish", async (orig) => {
  const real = await orig<typeof import("../lib/tinyfish")>();
  return {
    ...real,
    tfSearch: vi.fn(async (p: { page?: number; includeDomains?: string[] }) => {
      if (p.includeDomains) return { results: [] };
      const r = (path: string, position: number) => ({ url: `https://${path}`, title: path, snippet: "", position, site_name: "" });
      return p.page
        ? { results: [r("www.tinyfish.ai/", 4)] }
        : { results: [r("openai.com/a", 1), r("browserbase.com/", 2), r("www.tinyfish.ai/blog/what-is-a-web-agent", 3)] };
    }),
    tfFetch: vi.fn(async () => ({ results: [], errors: [] })),
  };
});

describe("rank check keeps looking when only another URL from the site is on page 1", () => {
  it("finds the audited page on page 2 (tinyfish.ai)", async () => {
    const { runSearchStage } = await import("../lib/stages/searchStage");
    const s = await runSearchStage({ url: "https://www.tinyfish.ai/", query: "web agent api" });
    expect(s.pagesChecked).toBe(2);
    expect(s.target.position).toBe(4);
  });
});
