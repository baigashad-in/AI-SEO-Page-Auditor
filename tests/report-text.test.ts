// Text the report writes for the site owner: URLs, errors, drafts, wording taken from the page,
// and how the agent's quote is matched. Cases follow live runs on all six demo pages.
import { describe, expect, it } from "vitest";
import { buildFindings, pageCasing, snippetDraft } from "../lib/analyze/findings";
import { buildReport, domainList } from "../lib/analyze/report";
import { reportToMarkdown } from "../lib/analyze/markdownReport";
import { quoteAppearsIn } from "../lib/analyze/text";
import { robotsVerdicts } from "../lib/parse/robots";
import { displayUrl, oneLineError, pageUrlAfterRedirect } from "../lib/url";
import type { FetchStageResult } from "../lib/types";
import { agent, browserStage, bundle, fetchStage, REDDIT_URL, search } from "./helpers";

// Fetch result shaped like Reddit's r/SEO page: a title and no meta description.
const redditFetch = (md: string, over: Partial<FetchStageResult> = {}) => fetchStage(md, over, REDDIT_URL, { title: "The SEO Authority", description: null });

describe("URLs and errors in the report", () => {
  it("keeps the requested URL when a challenge redirect only adds query parameters (Reddit)", () => {
    const final = "https://www.reddit.com/r/SEO/?solution=3f50&js_challenge=1&jsc_token=2824be&jsc_orig_r=";
    expect(pageUrlAfterRedirect(REDDIT_URL, final)).toBe(REDDIT_URL);
    expect(pageUrlAfterRedirect("https://a.com/old", "https://a.com/new")).toBe("https://a.com/new");
    expect(pageUrlAfterRedirect(REDDIT_URL, null)).toBe(REDDIT_URL);
  });

  it("shortens long share and tracking query strings for display (Substack)", () => {
    const long =
      "https://goodbetterbest.substack.com/p/3-simple-steps-to-make-pricing-changes?publication_id=22060&post_id=149705595&isFreemail=true&r=e0pzy&triedRedirect=true&utm_source=www.plg.news";
    expect(displayUrl(long)).toBe("https://goodbetterbest.substack.com/p/3-simple-steps-to-make-pricing-changes?\u2026");
    expect(displayUrl("https://shop.example/item?id=42")).toBe("https://shop.example/item?id=42");
  });

  it("puts errors on one line without terminal color codes (Substack browser timeout)", () => {
    const msg = 'page.goto: Timeout 45000ms exceeded.\nCall log:\n\u001b[2m  - navigating to "https://substack.com/@pricingsaas"\u001b[22m\n';
    expect(oneLineError(msg)).toBe("page.goto: Timeout 45000ms exceeded.");
  });

  it("keeps every TinyFish call on one row of the Markdown table", () => {
    const error = "page.goto: Timeout 45000ms exceeded.\nCall log:\n\u001b[2m  - navigating\u001b[22m\n";
    const br = { ...browserStage("<p>x</p>", undefined, {}, REDDIT_URL), ok: false, error };
    br.calls = [{ endpoint: "browser", purpose: "Load page over CDP", ms: 46484, ok: false, detail: error }];
    const md = reportToMarkdown(buildReport(bundle({ fetch: redditFetch("Reddit's No.1 SEO Community!"), browser: br }, REDDIT_URL), { url: REDDIT_URL }));
    const row = md.split("\n").find((l) => l.startsWith("| browser | Load page over CDP"))!;
    expect(row).toBe("| browser | Load page over CDP | 46.5s | failed: page.goto: Timeout 45000ms exceeded. |");
    expect(md).not.toContain("\u001b");
  });

  it("names a domain once with a page count", () => {
    expect(domainList(["https://pricingsaas.com/a", "https://www.pricingsaas.com/b", "https://pricingsaas.com/c", "https://en.wikipedia.org/x"])).toBe("pricingsaas.com (3 pages), wikipedia.org");
  });
});

describe("drafts and wording taken from the page", () => {
  it("writes query words the way the page writes them", () => {
    expect(pageCasing("pricingsaas newsletter", ["@pricingsaas · CEO and co-founder of PricingSaaS."])).toBe("PricingSaaS Newsletter");
    expect(pageCasing("learn react", ["LEARN REACT Describing the UI. React apps are made of components."])).toBe("Learn React");
    expect(pageCasing("seo subreddit", ["Reddit's No.1 SEO Community"])).toBe("SEO Subreddit");
  });

  it("drafts the description from the agent's answer even when it got past a block first (Reddit)", () => {
    const a = agent({
      answer_summary: "The SEO subreddit is a community for search engine optimization discussions and news.",
      blockers: [{ type: "other", description: "Initially blocked by network security; required a US proxy" }],
    });
    const md = "Reddit's No.1 SEO Community!\n\nso after seeing all the threads i wanted to actually test it instead of guessing from logs.";
    const finding = buildFindings(bundle({ fetch: redditFetch(md), agent: a }, REDDIT_URL)).find((x) => x.id === "meta-description-missing")!;
    expect(finding.fix.code).toContain("The SEO subreddit is a community");
  });

  it("does not cut a sentence at 'No.1' (Reddit)", () => {
    const a = agent({
      answer_summary:
        "The SEO subreddit on Reddit is a community dedicated to search engine optimization discussions and news. It is known as Reddit's No.1 SEO Community and hosts discussions on Google updates.",
    });
    const finding = buildFindings(bundle({ fetch: redditFetch("text"), agent: a }, REDDIT_URL)).find((x) => x.id === "meta-description-missing")!;
    expect(finding.fix.code).not.toMatch(/Reddit's No\."/);
    expect(finding.fix.code).toContain("The SEO subreddit on Reddit is a community dedicated to search engine optimization discussions and news.");
  });

  it("gives timeout advice for a timeout, not credit advice (Substack)", () => {
    const br = { ...browserStage("<p>x</p>"), ok: false, error: "page.goto: Timeout 45000ms exceeded." };
    const note = buildFindings(bundle({ fetch: fetchStage("x"), browser: br, agent: agent({}) })).find((x) => x.id === "audit-coverage")!;
    expect(note.fix.steps.join(" ")).toContain("ran out of time");
    expect(note.fix.steps.join(" ")).not.toContain("credits");
  });
});

describe("the agent's quote", () => {
  const raw = "Sign up Sign in The Medium Blog 3.4M followers· 5+ editors Product News Latest Newsletter Get the best of Medium";

  it("matches a quote with an added label (Medium)", () => {
    expect(quoteAppearsIn("The Medium Blog: 3.4M followers, 5+ editors. Available sections: Product News, Latest, Newsletter.", raw)).toBe(true);
  });

  it("still rejects a paraphrase in different words (react.dev)", () => {
    const text = "Welcome to the React documentation! This page will give you an introduction to 80% of the React concepts that you will use on a daily basis.";
    expect(quoteAppearsIn("This Quick Start guide provides all you need to start learning React: 80% of what you'll use in your daily React development.", text)).toBe(false);
  });

  it("rates a short quote that only extraction drops as low, and says crawlers do receive it (tinyfish.ai)", () => {
    const html = "<html><body><nav>Works with any AI</nav><p>Web APIs built for agents.</p><main><p>Search, fetch and browse the web.</p></main></body></html>";
    const b = bundle({ fetch: fetchStage("Search, fetch and browse the web."), browser: browserStage(html), agent: agent({ evidence_quote: "Web APIs built for agents" }) });
    const finding = buildFindings(b).find((x) => x.id === "answer-hidden")!;
    expect(finding.severity).toBe("low");
    expect(finding.confidence).toBe("low");
    expect(finding.visibilityImpact).toContain("Crawlers receive this text in the HTML");
    expect(finding.evidence.join(" ")).toContain("only 5 words");
  });
});

describe("description drafts when the agent could not answer", () => {
  it("uses the search snippet instead of the first post on a feed page (Reddit)", () => {
    const a = agent({ answer_found: false, answer_location: "not_on_page", blockers: [{ type: "login_wall", description: "You've been blocked by network security." }] });
    const md = "Reddit's No.1 SEO Community!\n\nso after seeing all the 'are AI bots ignoring robots.txt' threads i wanted to actually test it instead of guessing from logs.";
    const snippet = "r/SEO: The leading authority on all things SEO: AI SEO, GEO, LLM SEO, Technical SEO, Content SEO and SEO Architecture. Bring your ideas, problems\u2026";
    const s = search(1, { target: { position: 1, matchedUrl: REDDIT_URL, serpTitle: "The SEO Authority - Reddit", serpSnippet: snippet } }, REDDIT_URL, "seo subreddit");
    const finding = buildFindings(bundle({ fetch: redditFetch(md), agent: a, search: s }, REDDIT_URL, "seo subreddit")).find((x) => x.id === "meta-description-missing")!;
    expect(finding.fix.code).toContain('content="r/SEO: The leading authority on all things SEO: AI SEO, GEO, LLM SEO, Technical SEO, Content SEO and SEO Architecture."');
    expect(finding.fix.code).not.toContain("Bring your ideas");
    expect(finding.fix.code).not.toContain("so after seeing");
  });

  it("drops a leading date and an unfinished last sentence from snippets", () => {
    expect(snippetDraft("Jan 5, 2024 \u2014 Our guide explains how pricing pages work and what to test first on them. More tips for\u2026")).toBe(
      "Our guide explains how pricing pages work and what to test first on them.",
    );
    expect(snippetDraft("Too short\u2026")).toBeNull();
  });
});

describe("an answer behind a click that crawlers already receive (tinyfish.ai)", () => {
  it("is info, with an optional fix and no server-HTML advice", () => {
    const quote = "Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English.";
    const html = `<html><body><main><h2>TinyAgent</h2><p>${quote}</p></main></body></html>`;
    const a = agent({ answer_location: "after_interaction", interactions_needed: ["Dismissed banner", "Clicked TinyAgent product card"], evidence_quote: quote });
    const finding = buildFindings(bundle({ fetch: fetchStage(quote), browser: browserStage(html), agent: a })).find((x) => x.id === "answer-hidden")!;
    expect(finding.severity).toBe("info");
    expect(finding.visibilityImpact).toContain("No effect on AI visibility");
    expect(finding.fix.summary).toBe("Optional: show it to people without a click");
    expect(finding.fix.code).toBeUndefined();
  });
});

describe("the robots.txt line in the summary", () => {
  it("is hedged when the page ranks even though robots.txt closes it (Reddit)", () => {
    const v = robotsVerdicts("User-agent: *\nDisallow: /\n", REDDIT_URL);
    const f = redditFetch("text", { robots: { found: true, url: "https://www.reddit.com/robots.txt", note: "", verdicts: v.verdicts, sitemaps: [], status: "parsed" } });
    const r = buildReport(bundle({ fetch: f, search: search(1, {}, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit"), { url: REDDIT_URL });
    const line = r.connection.find((l) => l.includes("search crawlers"))!;
    expect(line).toContain("as served to TinyFish");
    expect(line).toContain("The page still ranks");
  });
});
