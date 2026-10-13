// The cross-report rules behind `npm run check`: reports the current code builds pass them, and
// each kind of false claim found in live runs breaks the rule written for it.
import { describe, expect, it } from "vitest";
import { checkReport, RULES } from "../lib/analyze/consistency";
import { buildReport } from "../lib/analyze/report";
import type { AuditReport } from "../lib/types";
import { agent, browserStage, bundle, fetchStage, LONG_TEXT, PAGE_URL, search } from "./helpers";

const rulesBroken = (r: AuditReport) => checkReport(r).map((v) => v.rule);

describe("reports built by the current code", () => {
  it("break no rule on a clean page, a JavaScript-only page, a blocked agent and a dismissed banner", () => {
    const page = `<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${LONG_TEXT}</p></main></body></html>`;
    const shell = `<html><head><title>App</title></head><body><div id="root"></div></body></html>`;
    const reports = [
      buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: browserStage(page), search: search(2), agent: agent({ evidence_quote: "Search engine optimization is the practice of improving how pages appear in search results." }) }), { url: PAGE_URL }),
      buildReport(bundle({ fetch: fetchStage("Loading"), browser: browserStage(shell, page), search: search(null) }), { url: PAGE_URL }),
      buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "captcha", description: "A CAPTCHA covered the page." }] }) }), { url: PAGE_URL }),
      buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ blockers: [{ type: "other", description: "A promotional banner appeared but did not block the main content." }] }) }), { url: PAGE_URL }),
    ];
    for (const r of reports) expect(checkReport(r)).toEqual([]);
  });

  it("break no rule on the 2026-10-13 run's cases: an 'other' block page, a 'modal' banner, hidden text, a paraphrased quote", () => {
    const raw = `<html><body><p>${"menu ".repeat(49)}</p></body></html>`;
    const ren = `<html><body><p>${"menu ".repeat(49)}</p><h2>Posts</h2><p>${"story ".repeat(264)}</p></body></html>`;
    const reports = [
      buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "other", description: "Network security block message prevented the page from loading." }] }) }), { url: PAGE_URL }),
      buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ blockers: [{ type: "modal", description: "A banner about Search and Fetch APIs free on every plan covering top portion of page" }] }) }), { url: PAGE_URL }),
      buildReport(bundle({ browser: browserStage(raw, ren, { renderedInnerTextWords: 163 }), search: search(1) }), { url: PAGE_URL }),
      buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: agent({ evidence_quote: "The blog is the official hub for product news and community updates." }) }), { url: PAGE_URL }),
    ];
    for (const r of reports) expect(checkReport(r)).toEqual([]);
  });

  it("gives every rule an id and a one-sentence promise", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) expect(r.says).toMatch(/^[A-Z"].+\.$/);
  });
});

describe("false claims from live runs break their rule", () => {
  const clean = () => buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: browserStage(`<html><body><p>${LONG_TEXT}</p></body></html>`), search: search(2) }), { url: PAGE_URL });

  it("a server-HTML strength while the page showed far more text (Medium, 2026-10-11 23:59)", () => {
    const r = clean();
    r.stages.browser!.renderedInnerTextWords = r.stages.browser!.rendered!.words * 2;
    expect(r.strengths.some((s) => s.startsWith("Content is in the server HTML"))).toBe(true);
    expect(rulesBroken(r)).toContain("server-html-vs-visible");
  });

  it("a blocker finding resting on a banner that did not block (Wikipedia, 2026-10-11 23:54)", () => {
    const r = clean();
    r.findings.unshift({
      id: "answer-blockers",
      category: "answerability",
      severity: "high",
      confidence: "medium",
      title: "The agent had to get past a block page",
      evidence: ["other: A promotional banner about Wiki Loves Monuments 2026 appeared at the top of the page but did not block the main content."],
      visibilityImpact: "",
      fix: { summary: "", steps: [], effort: "hours" },
      sources: ["agent"],
    });
    expect(rulesBroken(r)).toContain("blocker-did-not-block");
  });

  it("a dropped section that Fetch kept, glued to the next line (Medium, 2026-10-11 22:34)", () => {
    const r = clean();
    r.stages.fetch!.page!.markdown = "Here’s what stood out at Medium Day 2026TK, AI, and an unending love for reading.";
    r.findings.push({
      id: "extract-content-lost",
      category: "extraction",
      severity: "info",
      confidence: "medium",
      title: "AI extraction keeps 15% of the visible text",
      evidence: ['Sections dropped by extraction: "Here’s what stood out at Medium Day 2026", "Editor\'s picks"'],
      visibilityImpact: "",
      fix: { summary: "", steps: [], effort: "hours" },
      sources: ["fetch"],
    });
    const found = checkReport(r).filter((v) => v.rule === "dropped-sections");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("Medium Day 2026");
  });

  it("a summary that states a low-confidence finding as fact (tinyfish.ai, 2026-10-12 00:04)", () => {
    const r = clean();
    r.connection.push('An AI browsing agent answered "web agent api" (visible on load), but fetch tools never receive that answer.');
    expect(rulesBroken(r)).toContain("summary-backed");
  });

  it("'essentially the same page' at 77% (Wikipedia's fundraising banner)", () => {
    const r = clean();
    r.connection.push("The server HTML already carries 77% of the visible text, so crawlers that skip JavaScript see essentially the same page as users.");
    expect(rulesBroken(r)).toContain("same-page-wording");
  });

  it("broken punctuation in a draft, but not in text quoted from the page (react.dev, 2026-10-11 22:31)", () => {
    const r = clean();
    r.findings[0].fix.steps.push("Use this draft: including creating components,...");
    expect(rulesBroken(r)).toContain("text-artifacts");
    const quoted = clean();
    quoted.findings[0].evidence.push('Snippet search shows: "Sign in  Sign in, then more..."');
    expect(rulesBroken(quoted)).not.toContain("text-artifacts");
  });

  it("bot-block advice for a banner (tinyfish.ai, 2026-10-12 16:28)", () => {
    const r = clean();
    r.findings.push({
      id: "answer-blockers",
      category: "answerability",
      severity: "low",
      confidence: "medium",
      title: "The agent had to get past a banner",
      evidence: ["other: Top banner announcing Search and Fetch APIs free on every plan, dismissed via Dismiss button"],
      visibilityImpact: "",
      fix: { summary: "Do not cover content with overlays", steps: ["Check why automated browsers are blocked (bot manager, WAF rule, rate limit)."], effort: "hours" },
      sources: ["agent"],
    });
    expect(rulesBroken(r)).toContain("fix-matches-blocker");
  });

  it("findings out of severity order, or a Do-today item that is not a finding", () => {
    const r = clean();
    r.findings.reverse();
    r.doToday.push("no-such-finding");
    const found = checkReport(r).filter((v) => v.rule === "do-today").map((v) => v.message);
    expect(found.join(" ")).toContain("not sorted by severity");
    expect(found.join(" ")).toContain('"no-such-finding"');
  });

  it("a blocker titled 'a block page' with evidence labelled 'other' (Reddit, 2026-10-13 02:10)", () => {
    const r = clean();
    r.findings.unshift({
      id: "answer-blocked",
      category: "answerability",
      severity: "high",
      confidence: "medium",
      title: "An AI browsing agent was blocked before it could read the page (a block page)",
      evidence: ["other: Network security block message prevented the page from loading."],
      visibilityImpact: "",
      fix: { summary: "", steps: ["Check why automated browsers are blocked (bot manager, WAF rule, rate limit)."], effort: "hours" },
      sources: ["agent"],
    });
    expect(rulesBroken(r)).toContain("blocker-label-matches-title");
  });

  it("a banner the agent labelled 'modal' and the report called a pop-up (tinyfish.ai, 2026-10-13 02:11)", () => {
    const r = clean();
    r.findings.push({
      id: "answer-blockers",
      category: "answerability",
      severity: "low",
      confidence: "medium",
      title: "The agent had to get past a pop-up",
      evidence: ["pop-up: A banner about Search and Fetch APIs free on every plan covering top portion of page"],
      visibilityImpact: "",
      fix: { summary: "", steps: ["Delay newsletter or promo pop-ups, or remove them on content pages."], effort: "hours" },
      sources: ["agent"],
    });
    const found = checkReport(r).filter((v) => v.rule === "blocker-label-matches-title");
    expect(found.map((v) => v.message).join(" ")).toContain("describes a banner");
  });

  it("'a browser shows' the rendered count while far fewer words were visible (Medium, 2026-10-13 02:07)", () => {
    const r = clean();
    r.stages.browser!.renderedInnerTextWords = Math.round(r.stages.browser!.rendered!.words / 2);
    r.connection.push(`Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) receive 49 words; a browser shows ${r.stages.browser!.rendered!.words}.`);
    expect(rulesBroken(r)).toContain("visible-counts");
  });

  it("'98% of the visible text' when the server HTML has more words than the visible text (Wikipedia, 2026-10-13 02:04)", () => {
    const r = clean();
    r.stages.browser!.renderedInnerTextWords = Math.round(r.stages.browser!.raw!.words / 1.1);
    r.connection.push("The server HTML already carries 98% of the visible text, so crawlers that skip JavaScript see essentially the same page as users.");
    expect(rulesBroken(r)).toContain("visible-counts");
  });

  it("'agents are likely to hit the same wall' while the agent read the page (Reddit, 2026-10-13 20:06)", () => {
    const r = clean();
    r.stages.agent = agent({ evidence_quote: "Search engine optimization is the practice of improving how pages appear in search results." });
    r.connection.push('A real browser received a bot challenge page ("Reddit - Prove your humanity") instead of the content, so AI browsing agents are likely to hit the same wall. Browser-based checks were skipped.');
    expect(rulesBroken(r)).toContain("challenge-vs-agent");
  });

  it("crawlers 'receive' the server HTML while their user-agents got a block page (Medium, 2026-10-13 20:01)", () => {
    const r = clean();
    r.stages.browser!.botProbes = ["OAI-SearchBot", "PerplexityBot"].map((bot) => ({ bot, userAgent: bot, status: 403, words: 119, challenge: true, verdict: "blocked" as const }));
    r.connection.push("Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) receive 49 words; after JavaScript the page has 1829.");
    r.connection.push('An AI browsing agent answered "medium blog" (visible on load), and the same answer is in what non-JavaScript crawlers receive.');
    expect(checkReport(r).filter((v) => v.rule === "receive-vs-edge-block")).toHaveLength(2);
  });

  it("a visible-on-load strength next to a paraphrased quote (Medium, 2026-10-13 02:07)", () => {
    const r = clean();
    r.connection.push('An AI browsing agent answered "medium blog" (visible on load). Its quote was paraphrased rather than copied from the page, so which crawlers receive that text could not be checked.');
    r.strengths.push("An AI agent answered the query from content visible on load.");
    expect(rulesBroken(r)).toContain("strength-vs-paraphrase");
  });
});
