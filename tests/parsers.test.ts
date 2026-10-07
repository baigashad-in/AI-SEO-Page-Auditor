import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, robotsVerdicts } from "../lib/parse/robots";
import { markdownStats } from "../lib/parse/markdown";
import { htmlFacts, looksLikeChallenge } from "../lib/parse/html";
import { deriveQuery, stripBrand } from "../lib/analyze/query";
import { queryCoverage, quoteAppearsIn } from "../lib/analyze/text";
import { normalizeUrl, parseInputUrl, rootDomain, sameUrl } from "../lib/url";

describe("robots.txt", () => {
  const txt = [
    "User-agent: *",
    "Disallow: /admin/",
    "",
    "User-agent: GPTBot",
    "Disallow: /",
    "",
    "User-agent: PerplexityBot",
    "User-agent: OAI-SearchBot",
    "Disallow: /pricing",
    "Allow: /pricing/public",
    "",
    "Sitemap: https://x.com/sitemap.xml",
  ].join("\n");
  const parsed = parseRobots(txt);

  it("finds sitemaps and groups", () => {
    expect(parsed.sitemaps).toEqual(["https://x.com/sitemap.xml"]);
    expect(parsed.groups.length).toBe(3);
  });
  it("uses the specific group over *", () => {
    expect(isAllowed(parsed, "GPTBot", "/blog").allowed).toBe(false);
    expect(isAllowed(parsed, "ClaudeBot", "/blog").allowed).toBe(true);
    expect(isAllowed(parsed, "ClaudeBot", "/admin/x").allowed).toBe(false);
  });
  it("applies longest match and case-insensitive tokens", () => {
    expect(isAllowed(parsed, "perplexitybot", "/pricing").allowed).toBe(false);
    expect(isAllowed(parsed, "PerplexityBot", "/pricing/public/a").allowed).toBe(true);
    // A bot with its own group does not inherit "*" rules
    expect(isAllowed(parsed, "OAI-SearchBot", "/admin/").allowed).toBe(true);
  });
  it("supports * and $ wildcards", () => {
    const p = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=");
    expect(isAllowed(p, "Googlebot", "/a/file.pdf").allowed).toBe(false);
    expect(isAllowed(p, "Googlebot", "/a/file.pdf?x=1").allowed).toBe(true);
    expect(isAllowed(p, "Googlebot", "/search?q=x").allowed).toBe(false);
  });
  it("reports verdicts per bot with the matching rule", () => {
    const v = robotsVerdicts(txt, "https://x.com/pricing");
    const oai = v.verdicts.find((x) => x.bot.token === "OAI-SearchBot")!;
    expect(oai.allowed).toBe(false);
    expect(oai.matchedRule).toBe("Disallow: /pricing");
    expect(v.verdicts.find((x) => x.bot.token === "Googlebot")!.allowed).toBe(true);
  });
  it("treats empty Disallow as allow-all", () => {
    const p = parseRobots("User-agent: *\nDisallow:");
    expect(isAllowed(p, "Googlebot", "/x").allowed).toBe(true);
  });
});

describe("markdown stats", () => {
  it("counts headings, lists, tables and words", () => {
    const md = "# Title\n\nIntro paragraph with enough words to count as a paragraph here.\n\n## Plans\n\n- Basic plan\n- Pro plan\n\n| Plan | Price |\n|:-|:-|\n| Basic | $5 |\n\nSetext heading\n==\n";
    const s = markdownStats(md);
    expect(s.headings.map((h) => h.text)).toEqual(["Title", "Plans", "Setext heading"]);
    expect(s.h1Count).toBe(2);
    expect(s.listItems).toBe(2);
    expect(s.tableRows).toBe(2);
    expect(s.words).toBeGreaterThan(15);
  });
});

describe("html facts", () => {
  const ssr = `<!doctype html><html lang="en"><head><title>Pricing | Acme</title><meta name="description" content="Plans"><link rel="canonical" href="https://acme.com/pricing"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme"}</script><script type="application/ld+json">{bad json</script></head><body><main><h1>Pricing</h1><p>Basic costs five dollars per user per month.</p><img src="a.png"></main></body></html>`;
  const csr = `<!doctype html><html><head><title>App</title><script src="/assets/index-abc.js"></script></head><body><div id="root"></div><script>window.__NEXT_DATA__={}</script></body></html>`;
  it("extracts SSR facts", () => {
    const f = htmlFacts(ssr);
    expect(f.title).toBe("Pricing | Acme");
    expect(f.canonical).toBe("https://acme.com/pricing");
    expect(f.jsonLd.blocks).toBe(2);
    expect(f.jsonLd.parseErrors).toBe(1);
    expect(f.jsonLd.types).toContain("Product");
    expect(f.h1).toEqual(["Pricing"]);
    expect(f.hasMain).toBe(true);
    expect(f.imgMissingAlt).toBe(1);
    expect(f.htmlLang).toBe("en");
    expect(f.words).toBeGreaterThan(5);
  });
  it("detects an empty app shell and framework", () => {
    const f = htmlFacts(csr);
    expect(f.emptyAppShell).toBe(true);
    expect(f.words).toBe(0);
    expect(f.frameworkHints).toContain("Next.js");
  });
  it("detects challenge pages", () => {
    expect(looksLikeChallenge("<title>Just a moment...</title><div class=cf-chl>", 200)).toBe(true);
    expect(looksLikeChallenge("<p>hello</p>", 403)).toBe(true);
    expect(looksLikeChallenge("<p>hello world</p>", 200)).toBe(false);
  });
});

describe("query helpers", () => {
  it("strips brand suffixes", () => {
    expect(stripBrand("Best CRM for small agencies | Acme")).toBe("Best CRM for small agencies");
    expect(stripBrand("Acme \u2013 Project management software for teams")).toBe("Project management software for teams");
  });
  it("derives a query from H1 first", () => {
    expect(deriveQuery({ h1: "Pricing for small teams", title: "Pricing | Acme" })).toBe("Pricing for small teams");
  });
  it("measures coverage with light stemming", () => {
    const c = queryCoverage("crm pricing plans", "Our plan costs less. CRM for agencies.", "Our plan costs less", ["Plans"]);
    expect(c.inText.sort()).toEqual(["crm", "plan"]);
    expect(c.missing).toEqual(["pricing"]);
    expect(c.inFirstWords).toEqual(["plan"]);
  });
  it("matches quotes tolerantly", () => {
    const text = "Refunds: you get a full refund within 30 days of purchase, no questions asked. Contact support.";
    expect(quoteAppearsIn("You get a full refund within 30 days of purchase, no questions asked.", text)).toBe(true);
    expect(quoteAppearsIn("Refunds are processed within 90 business days by our billing partner team.", text)).toBe(false);
  });
});

describe("urls", () => {
  it("normalizes for matching", () => {
    expect(sameUrl("https://www.acme.com/pricing/?utm_source=x", "http://acme.com/pricing")).toBe(true);
    expect(normalizeUrl("https://acme.com/a?b=2&a=1")).toBe("acme.com/a?a=1&b=2");
    expect(rootDomain("https://blog.acme.co.uk/x")).toBe("acme.co.uk");
  });
  it("rejects private hosts", () => {
    expect(() => parseInputUrl("http://localhost:3000")).toThrow();
    expect(() => parseInputUrl("http://192.168.1.4/")).toThrow();
    expect(parseInputUrl("acme.com/pricing").toString()).toBe("https://acme.com/pricing");
  });
});
