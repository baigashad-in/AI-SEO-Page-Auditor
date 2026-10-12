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

  it("findings out of severity order, or a Do-today item that is not a finding", () => {
    const r = clean();
    r.findings.reverse();
    r.doToday.push("no-such-finding");
    const found = checkReport(r).filter((v) => v.rule === "do-today").map((v) => v.message);
    expect(found.join(" ")).toContain("not sorted by severity");
    expect(found.join(" ")).toContain('"no-such-finding"');
  });
});
