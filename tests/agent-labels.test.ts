// What the agent is asked to report about blockers, and how its answers are read. Since 2026-10-13 it
// can name a banner and a block page itself and says whether each blocker got in its way, instead of
// the report guessing from its free-text description (the same tinyfish.ai banner came back as
// modal, cookie_wall and other across runs; Reddit's block page as login_wall and other).
import { describe, expect, it } from "vitest";
import { buildFindings, obstacles } from "../lib/analyze/findings";
import { buildReport } from "../lib/analyze/report";
import { checkReport } from "../lib/analyze/consistency";
import { AGENT_OUTPUT_SCHEMA, agentGoal, normalizeAgentResult } from "../lib/stages/agentStage";
import { agent, bundle, fetchStage, LONG_TEXT, PAGE_URL } from "./helpers";

type BlockerSchema = { items: { properties: { type: { enum: string[] } }; required: string[] } };

describe("what the agent is asked", () => {
  it("offers banner and block_page as blocker types and asks whether each one got in the way", () => {
    const b = AGENT_OUTPUT_SCHEMA.properties.blockers as unknown as BlockerSchema;
    expect(b.items.properties.type.enum).toEqual(expect.arrayContaining(["banner", "block_page", "modal", "captcha", "other"]));
    expect(b.items.required).toEqual(["type", "description", "got_in_the_way"]);
  });

  it("does not count closing a banner that did not cover the answer as an interaction", () => {
    const goal = agentGoal(PAGE_URL, "q");
    expect(goal).toContain("Closing a banner or pop-up that did not cover the answer does not make it after_interaction.");
    expect(goal).toContain("banner (a bar or strip at the top or bottom of the page)");
    expect(goal).toContain("block_page (an 'access denied' or 'you have been blocked' page instead of the content)");
  });

  it("keeps got_in_the_way when the agent returns it, and leaves it out when it does not", () => {
    const base = { answer_found: true, answer_summary: "s", evidence_quote: null, answer_location: "visible_on_load", interactions_needed: [], page_purpose: "p", missing_information: [] };
    const withField = normalizeAgentResult({ ...base, blockers: [{ type: "banner", description: "Top bar", got_in_the_way: false }] })!;
    expect(withField.blockers[0]).toEqual({ type: "banner", description: "Top bar", got_in_the_way: false });
    const without = normalizeAgentResult({ ...base, blockers: [{ type: "modal", description: "Pop-up" }] })!;
    expect(without.blockers[0]).toEqual({ type: "modal", description: "Pop-up" });
  });
});

describe("reading the agent's own answers", () => {
  const findingFor = (blockers: { type: string; description: string; got_in_the_way?: boolean }[], answer_found = true) => {
    const a = agent({ answer_found, answer_summary: answer_found ? "Summary." : null, answer_location: answer_found ? "visible_on_load" : "not_on_page", blockers });
    return buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), agent: a })).find((x) => x.id === "answer-blockers" || x.id === "answer-blocked");
  };

  it("drops a banner the agent says did not get in the way, even when its description does not say so", () => {
    const a = agent({ blockers: [{ type: "banner", description: "Announcement bar about a product launch at the top of the page", got_in_the_way: false }] }).answer!;
    expect(obstacles(a)).toEqual([]);
    expect(findingFor(a.blockers)).toBeUndefined();
  });

  it("reports a banner the agent says got in the way, named as a banner with banner advice", () => {
    const f = findingFor([{ type: "banner", description: "Bar about free API plans covering the top of the page", got_in_the_way: true }])!;
    expect(f.title).toBe("The agent had to get past a banner");
    expect(f.evidence[0]).toBe("banner: Bar about free API plans covering the top of the page");
    expect(f.fix.steps.join(" ")).toContain("announcement banners");
  });

  it("still drops a pop-up whose description says it did not block, whatever the field says", () => {
    const a = agent({ blockers: [{ type: "modal", description: "A newsletter pop-up appeared but did not block the main content.", got_in_the_way: true }] }).answer!;
    expect(obstacles(a)).toEqual([]);
  });

  it("always counts a block page the agent names itself, with no override note", () => {
    const f = findingFor([{ type: "block_page", description: "Access denied page from the site's firewall", got_in_the_way: true }], false)!;
    expect(f.id).toBe("answer-blocked");
    expect(f.title).toContain("(a block page)");
    expect(f.evidence[0]).toBe("block page: Access denied page from the site's firewall");
    expect(f.fix.steps.join(" ")).toContain("automated browsers are blocked");
  });

  it("builds reports that break no rule with the new types", () => {
    for (const blockers of [
      [{ type: "banner", description: "Bar at the top", got_in_the_way: true }],
      [{ type: "block_page", description: "You have been blocked", got_in_the_way: true }],
      [{ type: "banner", description: "Bar at the top", got_in_the_way: false }],
    ]) {
      const found = blockers[0].type !== "block_page";
      const a = agent({ answer_found: found, answer_summary: found ? "Summary." : null, answer_location: found ? "visible_on_load" : "not_on_page", blockers });
      expect(checkReport(buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: a }), { url: PAGE_URL }))).toEqual([]);
    }
  });
});
