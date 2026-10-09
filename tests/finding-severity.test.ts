// Severity follows the evidence: what is missing, how much, and whether the page ranks anyway.
// Cases follow live runs on Medium, Substack and tinyfish.ai.
import { describe, expect, it } from "vitest";
import { markdownStats } from "../lib/parse/markdown";
import { buildFindings } from "../lib/analyze/findings";
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
