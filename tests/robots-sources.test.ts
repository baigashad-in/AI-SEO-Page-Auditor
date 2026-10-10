// robots.txt from two sources (Fetch's markdown copy and the browser's plain-text copy), files whose
// line breaks were lost, and files that close a site to every crawler.
import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, reflowRobots, robotsVerdicts } from "../lib/parse/robots";
import { buildFindings } from "../lib/analyze/findings";
import { withBrowserRobots } from "../lib/analyze/robotsSource";
import type { BrowserStageResult, FetchStageResult } from "../lib/types";
import { browserStage, bundle, fetchStage, PAGE_URL, REDDIT_URL, search } from "./helpers";

// Shaped like Reddit's robots.txt: comment lines, then one group that disallows everything.
const CLOSED_ROBOTS = "# Welcome to our robots.txt\n# policy: https://example.com/policy\n\nUser-agent: *\nDisallow: /\n";

describe("robots.txt with lost line breaks", () => {
  const joinedWithComments =
    "# Welcome to our robots.txt # We believe in an open internet, but not the misuse of public content. # See https://example.com/policy for details. User-agent: * Disallow: /";
  const joinedRules = "User-Agent: * Disallow: /m/ Disallow: /me/ Allow: /blog Sitemap: https://example.com/sitemap/sitemap.xml";

  it("restores rules hidden behind a joined comment header", () => {
    const v = robotsVerdicts(joinedWithComments, PAGE_URL);
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
      robots: { found: false, url: "https://example.com/robots.txt", note: "robots.txt has no valid directives. Crawler rules unknown.", verdicts: robotsVerdicts(null, PAGE_URL).verdicts, sitemaps: [], status: "unreadable", excerpt: "Something unexpected" },
    });
    const finding = buildFindings(bundle({ fetch: f })).find((x) => x.id === "access-robots-unreadable")!;
    expect(finding.evidence.join(" ")).toContain('What came back starts with: "Something unexpected"');
  });
});

describe("robots.txt read as plain text through the browser", () => {
  const unreadable = () =>
    fetchStage("# Page\n\ntext", {
      robots: { found: false, url: "https://example.com/robots.txt", note: "x", verdicts: robotsVerdicts(null, PAGE_URL).verdicts, sitemaps: [], status: "unreadable" },
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
    const b = withBrowserRobots(bundle({ fetch: fetchStage("# Page\n\ntext"), browser: plain("User-agent: *\nDisallow: /") }));
    expect(b.fetch!.robots.note).toContain("gave different results");
    expect(b.fetch!.robots.verdicts.every((x) => !x.allowed)).toBe(true);
  });

  it("is ignored when the browser also got a challenge page", () => {
    const b = withBrowserRobots(bundle({ fetch: unreadable(), browser: plain("<html><title>Just a moment...</title></html>", { contentType: "text/html" }) }));
    expect(b.fetch!.robots.status).toBe("unreadable");
  });

  it("turns a 404 into 'no robots.txt' when Fetch could not tell", () => {
    const b = withBrowserRobots(bundle({ fetch: unreadable(), browser: plain("Not found", { status: 404 }) }));
    expect(b.fetch!.robots.status).toBe("absent");
  });

  it("says when Fetch's copy had lost its line breaks", () => {
    const robots: FetchStageResult["robots"] = { found: true, url: "https://www.reddit.com/robots.txt", note: "", verdicts: robotsVerdicts(CLOSED_ROBOTS, REDDIT_URL).verdicts, sitemaps: [], status: "parsed", reflowed: true };
    const f = fetchStage("x", { robots }, REDDIT_URL);
    const br = browserStage("<p>x</p>", undefined, { robotsTxt: { url: "https://www.reddit.com/robots.txt", status: 200, contentType: "text/plain", text: CLOSED_ROBOTS } }, REDDIT_URL);
    expect(withBrowserRobots(bundle({ fetch: f, browser: br }, REDDIT_URL)).fetch!.robots.note).toContain("Fetch's copy had lost its line breaks");
  });
});

describe("robots.txt that closes the site to every crawler", () => {
  const closed = (): FetchStageResult["robots"] => {
    const v = robotsVerdicts(CLOSED_ROBOTS, REDDIT_URL);
    return { found: true, url: "https://www.reddit.com/robots.txt", note: "", verdicts: v.verdicts, sitemaps: [], status: "parsed" };
  };
  const notIndexed = { indexProbe: { query: "", found: false, position: null, domainUrls: [] } };

  it("is high with low confidence when the page ranks anyway (Reddit ranks #1)", () => {
    const b = bundle({ fetch: fetchStage("text", { robots: closed() }, REDDIT_URL), search: search(1, notIndexed, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit");
    const finding = buildFindings(b).find((x) => x.id === "access-robots-search-blocked")!;
    expect(finding.severity).toBe("high");
    expect(finding.confidence).toBe("low");
    expect(finding.evidence.join(" ")).toContain('Yet the page ranks #1 for "seo subreddit"');
  });

  it("stays critical when the page is not found in search", () => {
    const b = bundle({ fetch: fetchStage("text", { robots: closed() }, REDDIT_URL), search: search(null, notIndexed, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit");
    const finding = buildFindings(b).find((x) => x.id === "access-robots-search-blocked")!;
    expect(finding.severity).toBe("critical");
    expect(finding.confidence).toBe("high");
  });

  it("suggests an Allow rule without the challenge query string", () => {
    const user = buildFindings(bundle({ fetch: fetchStage("text", { robots: closed() }, REDDIT_URL) }, REDDIT_URL)).find((x) => x.id === "access-robots-user-blocked")!;
    expect(user.fix.steps.join(" ")).toContain('add "Allow: /r/SEO/" to its group');
  });
});

describe("newer robots.txt lines glued to the line before them", () => {
  it("keeps License out of the sitemap URL (medium.com)", () => {
    const joined = "User-Agent: GPTBot Disallow: / Allow: /about Sitemap: https://medium.com/sitemap/sitemap.xml License: https://medium.com/license.xml";
    const p = parseRobots(joined);
    expect(p.reflowed).toBe(true);
    expect(p.sitemaps).toEqual(["https://medium.com/sitemap/sitemap.xml"]);
  });

  it("keeps a Content-Usage line out of the user-agent name", () => {
    const p = parseRobots("User-agent: * Content-Usage: train-ai=n Allow: / Disallow: /private");
    expect(isAllowed(p, "OAI-SearchBot", "/blog").allowed).toBe(true);
    expect(isAllowed(p, "OAI-SearchBot", "/private/x").allowed).toBe(false);
  });

  it("reads only the first word of a path or sitemap value", () => {
    const p = parseRobots("User-agent: *\nDisallow: /tmp License: https://x.example/l.xml\nSitemap: https://x.example/s.xml extra");
    expect(isAllowed(p, "Googlebot", "/tmp/a").allowed).toBe(false);
    expect(p.sitemaps).toEqual(["https://x.example/s.xml"]);
  });

  it("drops a sitemap line that is not a full URL", () => {
    expect(parseRobots("User-agent: *\nDisallow:\nSitemap: /sitemap.xml").sitemaps).toEqual([]);
  });
});

describe("on-demand fetchers in a file that closes the site (Reddit)", () => {
  const closed = (): FetchStageResult["robots"] => {
    const v = robotsVerdicts(CLOSED_ROBOTS, REDDIT_URL);
    return { found: true, url: "https://www.reddit.com/robots.txt", note: "", verdicts: v.verdicts, sitemaps: [], status: "parsed" };
  };
  const notIndexed = { indexProbe: { query: "", found: false, position: null, domainUrls: [] } };

  it("shares the low confidence of the search-crawler finding when the page ranks anyway", () => {
    const b = bundle({ fetch: fetchStage("text", { robots: closed() }, REDDIT_URL), search: search(1, notIndexed, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit");
    const user = buildFindings(b).find((x) => x.id === "access-robots-user-blocked")!;
    expect(user.confidence).toBe("low");
    expect(user.evidence.join(" ")).toContain("served to TinyFish");
  });

  it("stays high confidence when the page is not found in search", () => {
    const b = bundle({ fetch: fetchStage("text", { robots: closed() }, REDDIT_URL), search: search(null, notIndexed, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit");
    expect(buildFindings(b).find((x) => x.id === "access-robots-user-blocked")!.confidence).toBe("high");
  });
});
