// Severity follows the evidence: what is missing, how much, and whether the page ranks anyway.
// Cases follow live runs on Medium, Substack and tinyfish.ai.
import { describe, expect, it } from "vitest";
import { markdownStats } from "../lib/parse/markdown";
import { buildFindings, topicGaps } from "../lib/analyze/findings";
import { agent, browserStage, bundle, fetchStage, PAGE_URL, search } from "./helpers";

describe("query words missing from the text", () => {
  it("rates a word that is in the title, on a page ranking #2, as low (Medium)", () => {
    const md = "Here is what stood out at our annual event and other news.";
    const b = bundle({ fetch: fetchStage(md, {}, PAGE_URL, { title: "The Medium Blog" }), search: search(2), query: "medium blog" });
    const finding = buildFindings(b).find((x) => x.id === "content-query-terms-missing")!;
    expect(finding.severity).toBe("low");
    expect(finding.title).toContain("only in the title or description");
  });

  it("keeps it high when the word is nowhere and the page does not rank (Substack)", () => {
    const md = "John Kotowski. CEO and co-founder of PricingSaaS. Good Better Best. 10K+ subscribers.";
    const b = bundle({ fetch: fetchStage(md, {}, PAGE_URL, { title: "John Kotowski | Substack", description: null }), search: search(null), query: "pricingsaas newsletter" });
    expect(buildFindings(b).find((x) => x.id === "content-query-terms-missing")!.severity).toBe("high");
  });
});

describe("thin and JavaScript-only text", () => {
  it("does not call a page thin as 'high' when the pages that rank have even less text", () => {
    const comps = [33, 28, 162].map((w, i) => ({ url: `https://other.com/${i}`, position: i + 1, title: "t", fetched: true, terms: {}, stats: markdownStats("word ".repeat(w)) }));
    const b = bundle({ fetch: fetchStage("word ".repeat(46)), search: search(null, { competitors: comps }) });
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
    expect(buildFindings(bundle({ fetch: fetchStage("word ".repeat(679)) })).find((x) => x.id === "struct-wall-of-text")!.title).toBe("679 extracted words and no headings");
  });
});

describe("obstacles the agent got past", () => {
  it("rates a banner the agent dismissed before answering on load as low (tinyfish.ai)", () => {
    const a = agent({ blockers: [{ type: "modal", description: "Promotional banner at the top of the page" }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blockers")!.severity).toBe("low");
    const notFound = agent({ answer_found: false, blockers: [{ type: "modal", description: "Newsletter pop-up" }] });
    expect(buildFindings(bundle({ agent: notFound })).find((x) => x.id === "answer-blockers")!.severity).toBe("medium");
  });
});

describe("blockers the agent labels wrongly", () => {
  it("treats a 'login wall' that says 'blocked by network security' as a block page (Reddit)", () => {
    const a = agent({
      answer_found: false,
      answer_location: "not_on_page",
      blockers: [{ type: "login_wall", description: "Reddit requires login to view the subreddit content, showing a 'You've been blocked by network security' message with a login button." }],
    });
    const finding = buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blocked")!;
    expect(finding.title).toContain("(a block page)");
    expect(finding.fix.steps.join(" ")).not.toContain("login wall");
    expect(finding.evidence.join(" ")).toContain("the agent called this a login wall, but it describes a bot block");
  });

  it("keeps a real login wall as a login wall", () => {
    const a = agent({ answer_found: false, answer_location: "not_on_page", blockers: [{ type: "login_wall", description: "The page asks members to sign in before showing the article." }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blocked")!.title).toContain("(a login wall)");
  });

  it("rates a banner the agent dismissed as low even when it answered after clicking (tinyfish.ai)", () => {
    const a = agent({ answer_location: "after_interaction", blockers: [{ type: "cookie_wall", description: "Cookie/notification banner at the top about Search and Fetch APIs" }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blockers")!.severity).toBe("low");
  });
});

describe("content gaps", () => {
  it("ignores generic words like 'content' even when competitors use them in headings (Substack)", () => {
    const comp = (url: string) => ({ url, title: "t", terms: { content: 4, pricing: 9, "pricing change": 3 }, headings: ["Engage with our content", "Pricing changes this week"] });
    const gaps = topicGaps("John Kotowski, CEO of PricingSaaS.", [comp("https://a.com/"), comp("https://b.com/"), comp("https://c.com/")]);
    expect(gaps.map(([term]) => term)).not.toContain("content");
  });
});

describe("content gaps from single words", () => {
  it("keeps phrases used by 2 of 3 pages but drops single words unless every page has them in a heading (tinyfish.ai)", () => {
    const steel = { url: "https://steel.dev/", title: "Steel", terms: { stuck: 2, human: 4, "open source": 3, "browser session": 6 }, headings: ["Help your agent whenever it's stuck", "Browse like humans", "Open source browser sessions"] };
    const paper = { url: "https://a.github.io/agents/", title: "Paper", terms: { "api call": 13 }, headings: ["API calls for agents"] };
    const bb = { url: "https://browserbase.com/", title: "Browserbase", terms: { stuck: 2, human: 5, "open source": 10, "browser session": 4 }, headings: ["Unblock agents that get stuck", "Research at a scale no human could", "Open source browser sessions"] };
    const terms = topicGaps("Search, fetch and browse the web with one API.", [steel, paper, bb]).map(([term]) => term);
    expect(terms).toEqual(expect.arrayContaining(["open source", "browser session"]));
    expect(terms).not.toContain("stuck");
    expect(terms).not.toContain("human");
  });
});

describe("blocker labels", () => {
  it("adds no override note when the agent's label was just 'other' (Reddit)", () => {
    const a = agent({ answer_found: false, answer_location: "not_on_page", blockers: [{ type: "other", description: "Page shows 'You've been blocked by network security' instead of the subreddit." }] });
    const finding = buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blocked")!;
    expect(finding.title).toContain("(a block page)");
    expect(finding.evidence.join(" ")).not.toContain("the agent called this");
  });
});
