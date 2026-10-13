// Text the report writes for the site owner: URLs, errors, drafts, wording taken from the page,
// and how the agent's quote is matched. Cases follow live runs on all six demo pages.
import { describe, expect, it } from "vitest";
import { answeredOnOtherPage, buildFindings, pageCasing, plainDashes, snippetDraft, suggestDescription, withoutPageFraming } from "../lib/analyze/findings";
import { AGENT_OUTPUT_SCHEMA, agentGoal } from "../lib/stages/agentStage";
import { buildReport, domainList } from "../lib/analyze/report";
import { reportToMarkdown } from "../lib/analyze/markdownReport";
import { quoteAppearsIn } from "../lib/analyze/text";
import { robotsVerdicts } from "../lib/parse/robots";
import { displayUrl, oneLineError, pageUrlAfterRedirect } from "../lib/url";
import type { FetchStageResult } from "../lib/types";
import { agent, browserStage, bundle, fetchStage, LONG_TEXT, PAGE_URL, REDDIT_URL, search } from "./helpers";

// A sentence from LONG_TEXT, so the agent's quote is found on the page.
const ON_PAGE_QUOTE = "Search engine optimization is the practice of improving how pages appear in search results.";

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
    expect(domainList(["https://pricingsaas.com/a", "https://www.pricingsaas.com/b", "https://pricingsaas.com/c", "https://en.wikipedia.org/x"])).toBe("pricingsaas.com (3 pages), en.wikipedia.org");
    expect(domainList(["https://newsletter.pricingsaas.com/", "https://pricingsaas.com/"])).toBe("newsletter.pricingsaas.com, pricingsaas.com");
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

describe("an agent that answers from another page (tinyfish.ai)", () => {
  const quote = "TinyFish Web Agent is a web agent API for programmatic workflows that need to complete goals on live websites.";
  const steps = [
    "Click 'TinyAgent' from the Products dropdown to navigate to the agent page",
    "Click the FAQ accordion 'What is TinyFish Web Agent, and is it a web agent API?' to expand the answer",
  ];
  const homepage = "<html><body><main><h1>The web stack for AI agents</h1><p>Search, extract, browse, and act on the web with one platform.</p></main></body></html>";
  const b = () =>
    bundle(
      { fetch: fetchStage("Search, extract, browse, and act on the web with one platform."), browser: browserStage(homepage), agent: agent({ answer_location: "after_interaction", interactions_needed: steps, evidence_quote: quote }) },
      undefined,
      "web agent api",
    );

  it("says the answer is on another page instead of blaming a click on this one", () => {
    const ids = buildFindings(b()).map((f) => f.id);
    expect(ids).toContain("answer-other-page");
    expect(ids).not.toContain("answer-hidden");
    const r = buildReport(b(), { url: "https://example.com/page" });
    expect(r.scores.answerability).toBe("answered_elsewhere");
    expect(r.connection.join(" ")).toContain("only on another page it opened");
    expect(r.strengths.join(" ")).not.toContain("answered the query");
  });

  it("asks the agent to stay on the exact page and offers an 'other page' answer", () => {
    const goal = agentGoal("https://www.tinyfish.ai/", "web agent api");
    expect(goal).toContain("Stay on this exact page (https://www.tinyfish.ai/). Do not open other pages");
    expect(goal).toContain("other_page if this page only links to the answer");
    expect((AGENT_OUTPUT_SCHEMA.properties.answer_location as { enum: string[] }).enum).toContain("other_page");
  });

  it("still treats in-page clicks as in-page", () => {
    expect(answeredOnOtherPage({ ...agent({}).answer!, interactions_needed: ["Clicked the FAQ accordion to expand the answer"] })).toBe(false);
  });
});

describe("description tags (react.dev has og:description but no meta description)", () => {
  const og = "The library for web and native user interfaces";
  const snippet = "This page will give you an introduction to 80% of the React concepts that you will use on a daily basis.";
  const html = (head: string) => `<html><head><title>Quick Start - React</title>${head}</head><body><main><h1>Quick Start</h1><p>${LONG_TEXT}</p></main></body></html>`;
  const ranked = () => search(1, { target: { position: 1, matchedUrl: PAGE_URL, serpTitle: null, serpSnippet: snippet } });

  it("reports the missing tag instead of comparing the snippet with og:description", () => {
    const page = html(`<meta property="og:description" content="${og}">`);
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: og }), browser: browserStage(page), search: ranked(), query: "learn react" }));
    const ogOnly = all.find((x) => x.id === "meta-description-og-only")!;
    expect(ogOnly.severity).toBe("low");
    expect(ogOnly.evidence.join(" ")).toContain(snippet.slice(0, 40));
    expect(all.find((x) => x.id === "vis-snippet-rewritten")).toBeUndefined();
    expect(all.find((x) => x.id === "meta-description-missing")).toBeUndefined();
  });

  it("still compares a real meta description with the snippet", () => {
    const page = html(`<meta name="description" content="${og}"><meta property="og:description" content="${og}">`);
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: og }), browser: browserStage(page), search: ranked(), query: "learn react" }));
    expect(all.find((x) => x.id === "vis-snippet-rewritten")).toBeDefined();
    expect(all.find((x) => x.id === "meta-description-og-only")).toBeUndefined();
  });

  it("confirms a missing description with the page HTML (Wikipedia)", () => {
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: null }), browser: browserStage(html("")) }));
    expect(all.find((x) => x.id === "meta-description-missing")!.evidence.join(" ")).toContain("no meta description tag either");
  });

  it("does not report a missing description that the page HTML has", () => {
    const page = html(`<meta name="description" content="${og}">`);
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: null }), browser: browserStage(page) }));
    expect(all.find((x) => x.id === "meta-description-missing")).toBeUndefined();
  });
});

describe("description drafts from the agent's summary", () => {
  it("drops the 'this page is' lead-in", () => {
    expect(withoutPageFraming("The react.dev/learn page is the official Quick Start guide.")).toBe("The official Quick Start guide.");
    expect(withoutPageFraming("The page provides a Quick Start guide covering core concepts.")).toBe("A Quick Start guide covering core concepts.");
    expect(withoutPageFraming("This page is the official React guide.")).toBe("The official React guide.");
    expect(withoutPageFraming("The Medium Blog page is a hub.")).toBe("The Medium Blog page is a hub.");
    expect(withoutPageFraming("React is a library for web and native user interfaces.")).toBe("React is a library for web and native user interfaces.");
  });

  it("uses the cleaned summary in the draft", () => {
    const draft = suggestDescription("", null, "This page is the official React Quick Start guide that introduces components, JSX and state.", null);
    expect(draft.startsWith("The official React Quick Start guide")).toBe(true);
  });
});

describe("summary wording", () => {
  it("does not credit Google for a TinyFish Search ranking (Medium)", () => {
    const raw = `<html><head><title>Medium</title></head><body><p>Sign in Write Get app</p></body></html>`;
    const rendered = `<html><head><title>The Medium Blog</title></head><body><p>Sign in Write Get app</p><p>${LONG_TEXT}</p></body></html>`;
    const r = buildReport(bundle({ fetch: fetchStage("Sign in"), browser: browserStage(raw, rendered), search: search(2), query: "medium blog" }), { url: PAGE_URL, query: "medium blog" });
    const line = r.connection.find((l) => l.startsWith("Non-JavaScript crawlers"))!;
    expect(line).toContain("The page still ranks #2 in TinyFish Search");
    expect(line).not.toContain("Google");
  });

  it("reads correctly when the agent was blocked (Reddit)", () => {
    const blocked = agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "captcha", description: "A CAPTCHA covered the page." }] });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: blocked, query: "seo subreddit" }), { url: PAGE_URL, query: "seo subreddit" });
    expect(r.connection.join(" ")).toContain('An AI browsing agent looking for "seo subreddit" was blocked');
  });

  it("names full hosts so two results on one domain stay apart (Substack, Wikipedia)", () => {
    const results = [
      { position: 1, title: "a", url: "https://developers.google.com/search/docs", snippet: "", siteName: "" },
      { position: 2, title: "b", url: "https://www.mtu.edu/seo", snippet: "", siteName: "" },
    ];
    const rank = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), search: search(3, { results }) })).find((x) => x.id === "vis-rank")!;
    expect(rank.evidence[0]).toContain("Above you: #1 developers.google.com, #2 mtu.edu");
  });
});

describe("edge-block evidence (Medium blocks three AI search user-agents)", () => {
  it("names the bots that robots.txt allows in one line", () => {
    const probe = (bot: string) => ({ bot, userAgent: bot, status: 403, words: 119, challenge: true, verdict: "blocked" as const });
    const br = browserStage(`<html><body><p>${LONG_TEXT}</p></body></html>`, undefined, { botProbes: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"].map(probe) });
    const edge = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), browser: br })).find((x) => x.evidence.some((e) => e.includes("server or CDN")))!;
    const lines = edge.evidence.filter((e) => e.startsWith("robots.txt allows"));
    expect(lines).toEqual(["robots.txt allows OAI-SearchBot, Claude-SearchBot and PerplexityBot, so this block happens at the server or CDN, not in robots.txt."]);
  });
});

describe("scores built without every stage (TinyFish credits ran out, 2026-10-10)", () => {
  const failed = () =>
    browserStage("", "", { ok: false, raw: null, rendered: null, renderedInnerTextWords: 0, error: "Not enough TinyFish credits for a Browser session (402)." });
  const noCredits = () => ({ ...agent({}), ok: false, status: "NOT_STARTED", answer: null, error: "Not enough TinyFish credits for an Agent run (402)." });

  it("labels readability and answerability as partial", () => {
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: failed(), agent: noCredits(), search: search(2) }), { url: PAGE_URL });
    expect(r.scores.missingStages).toEqual(["browser", "agent"]);
    const md = reportToMarkdown(r);
    expect(md).toContain("(partial: Browser did not run)");
    expect(md).toContain("(the Agent stage gave no result)");
    expect(r.connection[0]).toContain("partial score");
  });

  it("does not call a bot challenge a missing stage (Reddit)", () => {
    const challenged = browserStage("<html><title>Prove your humanity</title></html>", undefined, { challenge: { title: "Prove your humanity", words: 3 } });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: challenged, agent: agent({}), search: search(1) }), { url: PAGE_URL });
    expect(r.scores.missingStages).toEqual([]);
    expect(reportToMarkdown(r)).not.toContain("partial");
  });
});

describe("agent quotes with a label stitched on (tinyfish.ai, 2026-10-10)", () => {
  const fetchText = "Access the web that search can't reach. Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English. It works the live site.";
  const quote = "Multi-step web automation. Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English.";

  it("counts the quote as present when its full sentences are, even if the short label was dropped", () => {
    expect(quoteAppearsIn(quote, fetchText)).toBe(true);
  });

  it("still fails when a full sentence is missing", () => {
    expect(quoteAppearsIn("Multi-step web automation. Navigate, fill forms, authenticate, return structured results. Book a demo with our sales team today.", fetchText)).toBe(false);
  });

  it("does not report the answer as dropped by extraction", () => {
    const raw = `<html><body><nav>TinyAgent Multi-step web automation</nav><p>${fetchText}</p><p>${LONG_TEXT}</p></body></html>`;
    const a = agent({ evidence_quote: quote, answer_location: "visible_on_load", interactions_needed: ["Dismiss notification banner"] });
    const all = buildFindings(bundle({ fetch: fetchStage(`${fetchText}\n\n${LONG_TEXT}`), browser: browserStage(raw), agent: a, query: "web agent api" }));
    expect(all.find((x) => x.evidence.join(" ").includes("In TinyFish Fetch extraction: no"))).toBeUndefined();
  });
});

describe("drafted descriptions use plain punctuation (react.dev)", () => {
  it("turns dashes from the agent's summary into commas", () => {
    const draft = suggestDescription("", null, "A structured path to learn React, starting with a Quick Start that covers 80% of core concepts\u2014components, JSX, styling and state.", null);
    expect(draft).not.toMatch(/[\u2014\u2013]/);
    expect(draft).toContain("core concepts, components");
  });

  it("keeps a numeric range readable", () => {
    expect(plainDashes("History 2012\u20132016 and later")).toBe("History 2012-2016 and later");
  });
});

describe("agent quotes that end with the site's footer tagline (tinyfish.ai, 2026-10-11)", () => {
  const fetchText = "Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English. It works the live site.";

  it("counts the quote as present when its sentences carry most of its words", () => {
    expect(quoteAppearsIn("Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English. Web APIs built for agents.", fetchText)).toBe(true);
  });

  it("does not count a quote whose main sentences are missing", () => {
    expect(quoteAppearsIn("Navigate, fill forms, authenticate, return structured results. Book a demo with our sales team today. Pricing starts at ten dollars a month.", fetchText)).toBe(false);
  });
});

describe("an agent that answered only after getting past a CAPTCHA (medium.com/blog, 2026-10-11)", () => {
  const passed = () =>
    agent({
      answer_found: true,
      evidence_quote: "This page is the homepage for The Medium Blog, the official publication for product news.",
      answer_location: "visible_on_load",
      interactions_needed: ["reconfigured browser to bypass Cloudflare CAPTCHA"],
      blockers: [{ type: "captcha", description: "Cloudflare security verification with 'Verify you are human' checkbox blocked initial access" }],
    });

  it("scores it as answered with effort and says why", () => {
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: passed(), query: "medium blog" }), { url: PAGE_URL, query: "medium blog" });
    expect(r.scores.answerability).toBe("answered_with_effort");
    expect(r.connection.join(" ")).toContain("after getting past a CAPTCHA");
    expect(r.strengths.join(" ")).not.toContain("visible on load");
  });

  it("keeps the strength when only a banner was in the way", () => {
    // A quote that is on the page: the strength only names where the answer is when the quote is found.
    const banner = agent({ answer_found: true, answer_location: "visible_on_load", evidence_quote: ON_PAGE_QUOTE, blockers: [{ type: "modal", description: "Promo banner at the top" }] });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: banner }), { url: PAGE_URL });
    expect(r.scores.answerability).toBe("answered");
    expect(r.strengths.join(" ")).toContain("visible on load");
  });
});

describe("a crawler user-agent request that timed out (react.dev, 2026-10-11)", () => {
  it("names the bots that were checked and the one that was not", () => {
    const probe = (bot: string, ok: boolean) =>
      ok
        ? { bot, userAgent: bot, status: 200, words: 900, challenge: false, verdict: "ok" as const }
        : { bot, userAgent: bot, status: null, words: 0, challenge: false, verdict: "error" as const, error: "page.goto: Timeout 20000ms exceeded." };
    const br = browserStage(`<html><body><p>${LONG_TEXT}</p></body></html>`, undefined, {
      botProbes: [probe("OAI-SearchBot", false), probe("Claude-SearchBot", true), probe("PerplexityBot", true)],
    });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: br }), { url: PAGE_URL });
    const line = r.strengths.find((x) => x.startsWith("Requests with AI search crawler"))!;
    expect(line).toContain("(Claude-SearchBot, PerplexityBot)");
    expect(line).toContain("The OAI-SearchBot request timed out");
  });
});

describe("agent quotes that start with a tab label (tinyfish.ai, 2026-10-11 19:29)", () => {
  const fetchText = "Access the web that search can't reach. Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English.";

  it("counts the quote as present when only the label is missing from the text", () => {
    expect(quoteAppearsIn("TinyAgent: Multi-step web automation. Navigate, fill forms, authenticate, return structured results.", fetchText)).toBe(true);
  });

  it("never treats a missing part with a number as a label", () => {
    expect(quoteAppearsIn("From $49 a month. Navigate, fill forms, authenticate, return structured results.", fetchText)).toBe(false);
  });
});

describe("lists in summary lines and titles", () => {
  const probe = (bot: string) => ({ bot, userAgent: bot, status: 403, words: 119, challenge: true, verdict: "blocked" as const });

  it("joins the blocked crawler user-agents with 'and' and keeps the plural (Medium)", () => {
    const br = browserStage(`<html><body><p>${LONG_TEXT}</p></body></html>`, undefined, { botProbes: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"].map(probe) });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: br }), { url: PAGE_URL });
    expect(r.connection).toContain(
      "Requests sent with the OAI-SearchBot, Claude-SearchBot and PerplexityBot user-agents got a block or challenge page from your server or CDN. If the real crawlers are blocked too, those engines cannot index the page at all, whatever robots.txt says.",
    );
  });

  it("joins the search crawlers robots.txt excludes with 'and' (Reddit)", () => {
    const robots = robotsVerdicts("User-agent: *\nDisallow: /", REDDIT_URL);
    const f = redditFetch(LONG_TEXT, { robots: { ...redditFetch(LONG_TEXT).robots, verdicts: robots.verdicts } });
    const b = bundle({ fetch: f, search: search(1, {}, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit");
    const r = buildReport(b, { url: REDDIT_URL, query: "seo subreddit" });
    expect(r.connection.join(" ")).toContain("excludes the OpenAI, Anthropic, Perplexity and Apple search crawlers");
    expect(r.findings.find((x) => x.id === "access-robots-search-blocked")!.title).toBe(
      "robots.txt blocks Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot, PerplexityBot and Applebot from this URL",
    );
  });

  it("does not end a line in '?….' when the other ranking URL was shortened (Substack)", () => {
    const long = "https://goodbetterbest.substack.com/p/3-simple-steps-to-make-pricing-changes?publication_id=22060&post_id=149705595&isFreemail=true&r=e0pzy";
    const s = search(null, { domain: { bestPosition: 5, urls: [{ position: 5, url: long }] } });
    const line = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), search: s }), { url: PAGE_URL }).connection.find((l) => l.startsWith("Another page"))!;
    expect(line.endsWith("pricing-changes?…")).toBe(true);
    const short = search(null, { domain: { bestPosition: 1, urls: [{ position: 1, url: "https://example.com/" }] } });
    expect(buildReport(bundle({ fetch: fetchStage(LONG_TEXT), search: short }), { url: PAGE_URL }).connection.find((l) => l.startsWith("Another page"))!.endsWith("https://example.com/.")).toBe(true);
  });
});

describe("drafted descriptions from an agent summary that starts 'This is' (react.dev, 2026-10-11 22:31)", () => {
  const summary =
    "This is the official React Quick Start learning guide that introduces the core concepts used in daily React development, including creating components, JSX syntax, styling, rendering lists, responding to events, managing state with Hooks, and sharing data between components.";

  it("drops the lead-in and does not end in a comma before the dots", () => {
    const draft = suggestDescription("", null, summary, null);
    expect(draft.startsWith("The official React Quick Start")).toBe(true);
    expect(draft).not.toMatch(/[,;:]\.\.\.$/);
    expect(draft.endsWith("...")).toBe(true);
    expect(draft.length).toBeLessThanOrEqual(155);
  });

  it("keeps a summary that only mentions 'this is' later on", () => {
    expect(withoutPageFraming("Search engine optimization is what this is about.")).toBe("Search engine optimization is what this is about.");
  });
});

describe("blockers the agent says did not get in the way (Wikipedia, 2026-10-11 23:54)", () => {
  const banner = {
    type: "other",
    description: "A promotional banner about Wiki Loves Monuments 2026 appeared at the top of the page but did not block the main content.",
  };

  it("does not report or score a banner that did not block", () => {
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ answer_found: true, answer_location: "visible_on_load", evidence_quote: ON_PAGE_QUOTE, blockers: [banner] }) }), { url: PAGE_URL });
    expect(r.findings.find((x) => x.id === "answer-blockers")).toBeUndefined();
    expect(r.scores.answerability).toBe("answered");
    expect(r.strengths.join(" ")).toContain("visible on load");
  });

  it("still treats Reddit's block pages as blocks, even when they say 'no content visible' or 'not accessible'", () => {
    for (const description of [
      "The page shows 'You've been blocked by network security' with no subreddit content visible.",
      "The Reddit page is blocked by network security. The actual SEO subreddit content is not accessible.",
      "Network security block prevented the page from loading the subreddit content",
    ]) {
      const a = agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "other", description }] });
      const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: a }), { url: PAGE_URL });
      expect(r.findings.find((x) => x.id === "answer-blocked"), description).toBeDefined();
    }
  });

  it("does not read 'accessible' or 'human' in a banner as a block", () => {
    const a = agent({ answer_found: true, answer_location: "visible_on_load", blockers: [{ type: "other", description: "An announcement about human rights day sat above the accessible main text." }] });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: a }), { url: PAGE_URL });
    expect(r.scores.answerability).toBe("answered");
    expect(r.findings.find((x) => x.id === "answer-blockers")!.title).toBe("The agent had to get past a banner");
  });

  it("does not count a step that says the agent stayed on the page as leaving it", () => {
    expect(answeredOnOtherPage(agent({ interactions_needed: ["Read the intro; did not navigate to another page"] }).answer!)).toBe(false);
    expect(answeredOnOtherPage(agent({ interactions_needed: ["Navigated to the pricing page"] }).answer!)).toBe(true);
  });
});

describe("summary lines that must match the findings (2026-10-12 run)", () => {
  it("hedges a short quote the same way the finding does (tinyfish.ai)", () => {
    const html = `<html><body><p>${LONG_TEXT}</p><footer><p>Web APIs built for agents.</p></footer></body></html>`;
    const a = agent({ evidence_quote: "Web APIs built for agents.", answer_location: "visible_on_load" });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: browserStage(html), agent: a, query: "web agent api" }), { url: PAGE_URL, query: "web agent api" });
    const line = r.connection.find((l) => l.startsWith("An AI browsing agent answered"))!;
    expect(line).toContain("short quote");
    expect(line).not.toContain("never receive that answer");
    expect(r.findings.find((x) => x.id === "answer-hidden")!.confidence).toBe("low");
  });

  it("names what JavaScript adds when the server HTML has 70 to 90% of the text (Wikipedia's fundraising banner)", () => {
    const raw = `<html><body><p>${"word ".repeat(770)}</p></body></html>`;
    const ren = `<html><body><h2>Donor-Advised Fund (DAF)</h2><p>${"gift ".repeat(230)}</p><p>${"word ".repeat(770)}</p></body></html>`;
    const br = browserStage(raw, ren, { onlyAfterJs: { headings: ["Donor-Advised Fund (DAF)"], title: false, description: false, canonical: false, h1: false, jsonLd: false } });
    const line = buildReport(bundle({ fetch: fetchStage("word ".repeat(770)), browser: br }), { url: PAGE_URL }).connection.find((l) => l.includes("server HTML"))!;
    expect(line).toContain('JavaScript adds the rest, including "Donor-Advised Fund (DAF)"');
    expect(line).not.toContain("essentially the same page");
  });
});

describe("one blocker, one kind: wording and fix agree (tinyfish.ai, 2026-10-12 16:28)", () => {
  const fixFor = (description: string, answer_found = true) => {
    const a = agent({ answer_found, answer_summary: answer_found ? "Summary." : null, answer_location: answer_found ? "after_interaction" : "not_on_page", blockers: [{ type: "other", description }] });
    const f = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), agent: a })).find((x) => x.id === "answer-blockers" || x.id === "answer-blocked")!;
    return { title: f.title, steps: f.fix.steps.join(" ") };
  };

  it("gives a banner banner advice, not bot-block advice", () => {
    const { title, steps } = fixFor("Top banner announcing Search and Fetch APIs free on every plan, dismissed via Dismiss button");
    expect(title).toBe("The agent had to get past a banner");
    expect(steps).toContain("announcement banners");
    expect(steps).not.toContain("automated browsers are blocked");
  });

  it("still gives a block page bot-block advice (Reddit)", () => {
    const { title, steps } = fixFor("The page returned a network security block message preventing access to the subreddit content.", false);
    expect(title).toContain("a block page");
    expect(steps).toContain("automated browsers are blocked");
  });

  it("does not guess bot-block advice for an obstacle it cannot name", () => {
    const { title, steps } = fixFor("A large image carousel took up the first screen");
    expect(title).toBe("The agent had to get past an obstacle");
    expect(steps).not.toContain("automated browsers are blocked");
  });
});

describe("one blocker, one name: evidence label, title and fix agree (2026-10-13)", () => {
  const blockerFinding = (blockers: { type: string; description: string }[], answer_found = true) => {
    const a = agent({ answer_found, answer_summary: answer_found ? "Summary." : null, answer_location: answer_found ? "visible_on_load" : "not_on_page", blockers });
    return buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), agent: a })).find((x) => x.id === "answer-blockers" || x.id === "answer-blocked")!;
  };

  it("labels an 'other' block page as a block page in the evidence too (Reddit)", () => {
    const f = blockerFinding([{ type: "other", description: "Network security block message prevented the page from loading, showing only a block notice." }], false);
    expect(f.title).toContain("(a block page)");
    expect(f.evidence[0]).toBe("block page: Network security block message prevented the page from loading, showing only a block notice.");
  });

  it("calls a 'modal' the agent describes as a banner a banner, with banner advice (tinyfish.ai)", () => {
    const f = blockerFinding([{ type: "modal", description: "A banner about Search and Fetch APIs free on every plan covering top portion of page" }]);
    expect(f.title).toBe("The agent had to get past a banner");
    expect(f.evidence[0]).toBe("banner: A banner about Search and Fetch APIs free on every plan covering top portion of page (the agent called this a modal, but it describes a banner)");
    expect(f.fix.steps.join(" ")).toContain("announcement banners");
    expect(f.fix.steps.join(" ")).not.toContain("pop-ups");
  });

  it("keeps a 'modal' the agent calls a pop-up as a pop-up, labelled the way the title says", () => {
    const f = blockerFinding([{ type: "modal", description: "Banner popup about Search and Fetch APIs free on every plan with dismiss button" }]);
    expect(f.title).toBe("The agent had to get past a pop-up");
    expect(f.evidence[0]).toBe("pop-up: Banner popup about Search and Fetch APIs free on every plan with dismiss button");
  });

  it("lists a block page the agent labelled 'modal' in the blocked finding", () => {
    const f = blockerFinding([{ type: "modal", description: "You've been blocked by network security." }], false);
    expect(f.id).toBe("answer-blocked");
    expect(f.title).toContain("(a block page)");
    expect(f.evidence[0]).toContain("block page: You've been blocked by network security.");
  });
});

describe("rendered and visible word counts are named for what they are (2026-10-13)", () => {
  it("says 'rendered text' for the server-HTML share, which both counts include hidden text in (Wikipedia, react.dev)", () => {
    const page = `<html><body><p>${LONG_TEXT}</p></body></html>`;
    const line = buildReport(bundle({ browser: browserStage(page, page, { renderedInnerTextWords: 900 }) }), { url: PAGE_URL }).connection.find((l) => l.includes("server HTML"))!;
    expect(line).toMatch(/carries \d+% of the rendered text/);
    expect(line).not.toContain("visible text");
  });

  it("gives the visible count next to the rendered count when much of the page is hidden (Medium)", () => {
    const raw = `<html><body><p>${"menu ".repeat(49)}</p></body></html>`;
    const ren = `<html><body><p>${"menu ".repeat(49)}</p><h2>Posts</h2><p>${"story ".repeat(264)}</p></body></html>`;
    const br = browserStage(raw, ren, { renderedInnerTextWords: 163 });
    const r = buildReport(bundle({ browser: br, search: search(1) }), { url: PAGE_URL });
    const line = r.connection.find((l) => l.startsWith("Non-JavaScript crawlers"))!;
    expect(line).toContain(`receive 49 words; after JavaScript the page has ${br.rendered!.words} (163 of them visible).`);
    expect(line).not.toContain("a browser shows");
    expect(reportToMarkdown(r)).toContain(`* Rendered page (browser): ${br.rendered!.words} words, 163 of them visible`);
  });

  it("adds no visible count when most of the rendered text is visible", () => {
    const page = `<html><body><p>${LONG_TEXT}</p></body></html>`;
    const r = buildReport(bundle({ browser: browserStage(page, page, { renderedInnerTextWords: 1180 }) }), { url: PAGE_URL });
    expect(r.views.visibleWords).toBeNull();
    expect(reportToMarkdown(r)).not.toContain("of them visible");
  });
});

describe("what each reader sees, when a count is missing (2026-10-13)", () => {
  it("says why instead of 'n/a words' (Browser failed on Substack, Fetch blocked on Medium)", () => {
    const br = { ...browserStage("<p>x</p>"), ok: false, raw: null, rendered: null, renderedInnerTextWords: 0, error: "browserType.connectOverCDP: WebSocket error" };
    const fe = { ...fetchStage(""), page: null, stats: null, pageError: { url: PAGE_URL, error: "bot_blocked" } };
    const md = reportToMarkdown(buildReport(bundle({ fetch: fe, browser: br }), { url: PAGE_URL }));
    expect(md).not.toContain("n/a words");
    expect(md).toContain("* Raw server HTML (non-JavaScript crawlers): not measured (Browser stage failed)");
    expect(md).toContain("* Rendered page (browser): not measured (Browser stage failed)");
    expect(md).toContain("* AI fetch extraction (TinyFish Fetch): none (Fetch could not read the page: bot_blocked)");
  });
});

describe("the agent strength only says where the answer is when the quote is on the page (Medium, 2026-10-13)", () => {
  const strengthFor = (quote: string) =>
    buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ evidence_quote: quote }) }), { url: PAGE_URL }).strengths.find((s) => s.startsWith("An AI agent answered"));

  it("drops 'from content visible on load' for a paraphrased quote", () => {
    expect(strengthFor("The blog is the official hub for product news and community updates.")).toBe("An AI agent answered the query.");
  });

  it("keeps it when the quote is on the page", () => {
    expect(strengthFor(ON_PAGE_QUOTE)).toBe(
      "An AI agent answered the query from content visible on load.",
    );
  });
});

describe("the summary agrees with the agent and the crawler probes (2026-10-13, v27 run)", () => {
  const blockedProbe = (bot: string) => ({ bot, userAgent: bot, status: 403, words: 119, challenge: true, verdict: "blocked" as const });

  it("does not say agents will hit a challenge that the agent got past without meeting (Reddit)", () => {
    const br = { ...browserStage("<p>Prove your humanity</p>"), challenge: { title: "Reddit - Prove your humanity", words: 39 } };
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: br, agent: agent({ evidence_quote: ON_PAGE_QUOTE }) }), { url: PAGE_URL });
    const line = r.connection.find((l) => l.startsWith("A real browser received a bot challenge"))!;
    expect(line).not.toContain("likely to hit the same wall");
    expect(line).toContain("The AI browsing agent reached the content without a challenge, so the challenge does not stop every visitor");
    expect(r.findings.find((f) => f.id === "access-browser-challenged")!.evidence).toContain(
      "The AI browsing agent reached the content without a challenge, so the challenge does not stop every visitor.",
    );
  });

  it("still warns about the challenge when the agent was stopped too", () => {
    const br = { ...browserStage("<p>Prove your humanity</p>"), challenge: { title: "Reddit - Prove your humanity", words: 39 } };
    const blocked = agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "block_page", description: "You have been blocked", got_in_the_way: true }] });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: br, agent: blocked }), { url: PAGE_URL });
    expect(r.connection.join(" ")).toContain("so AI browsing agents are likely to hit the same wall");
  });

  it("does not say crawlers receive the server HTML when their user-agents got a block page (Medium)", () => {
    const raw = `<html><body><p>The Medium Blog. ${"menu ".repeat(45)}</p></body></html>`;
    const ren = `<html><body><p>The Medium Blog. ${"menu ".repeat(45)}</p><h2>Posts</h2><p>${"story ".repeat(264)}</p></body></html>`;
    const br = browserStage(raw, ren, { botProbes: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"].map(blockedProbe) });
    const fe = { ...fetchStage(""), page: null, stats: null, pageError: { url: PAGE_URL, error: "bot_blocked" } };
    const r = buildReport(bundle({ fetch: fe, browser: br, agent: agent({ evidence_quote: "The Medium Blog" }) }), { url: PAGE_URL });
    const text = r.connection.join(" ");
    expect(text).toContain(`Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) get at most ${br.raw!.words} words`);
    expect(text).toContain("Those engines index the smaller version at best");
    expect(text).toContain(
      'An AI browsing agent answered "q" (visible on load). Its quote is in the server HTML, but the AI search crawler user-agents tested got a block page instead (see above). The quote is short ("The Medium Blog"), so it may be a heading or tagline rather than the answer; treat this as a weak signal.',
    );
    expect(text).not.toMatch(/\(GPTBot, ClaudeBot, PerplexityBot\) receive|non-JavaScript crawlers receive/);
  });

  it("keeps 'receive' when no crawler user-agent was blocked", () => {
    const page = `<html><body><p>${LONG_TEXT}</p></body></html>`;
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: browserStage(page), agent: agent({ evidence_quote: ON_PAGE_QUOTE }) }), { url: PAGE_URL });
    expect(r.connection.join(" ")).toContain("the same answer is in what fetch tools and non-JavaScript crawlers receive.");
  });
});
