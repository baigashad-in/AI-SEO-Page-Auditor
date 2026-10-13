// The agent runs several times per audit (AGENT_RUNS, default 3), because one run can differ from the
// next: Medium showed the agent a CAPTCHA in 7 of 16 runs, and tinyfish.ai's answer was "visible on
// load" in 8 runs and "after interaction" in 8. The report shows the most common result and says
// when the runs differ. TinyFish is mocked; nothing here calls the real API.
import { afterEach, describe, expect, it, vi } from "vitest";

const { started, results } = vi.hoisted(() => ({
  started: [] as Record<string, unknown>[],
  results: new Map<string, unknown>(),
}));

vi.mock("../lib/tinyfish", async (orig) => {
  const real = await orig<typeof import("../lib/tinyfish")>();
  return {
    ...real,
    tfStartAgentRun: vi.fn(async (body: Record<string, unknown>) => {
      started.push(body);
      return { run_id: `run-${started.length}`, error: null };
    }),
    tfGetAgentRun: vi.fn(async (id: string) => ({ run_id: id, status: "COMPLETED", result: results.get(id), error: null, num_of_steps: 4 })),
    tfCancelAgentRun: vi.fn(async () => {}),
  };
});

import { mergeAgentRuns } from "../lib/analyze/agentRuns";
import { agentAgreementNote, chooseAgentRun, reportBundle } from "../lib/analyze/findings";
import { buildReport } from "../lib/analyze/report";
import { checkReport } from "../lib/analyze/consistency";
import { agentProxy, agentRunCount, runAgentStage } from "../lib/stages/agentStage";
import type { AgentAnswer, AgentStageResult } from "../lib/types";
import { agent, bundle, fetchStage, LONG_TEXT, PAGE_URL, search } from "./helpers";

const QUOTE = "Search engine optimization is the practice of improving how pages appear in search results.";
const answered = (): AgentAnswer => agent({ evidence_quote: QUOTE }).answer!;
const captcha = (): AgentAnswer =>
  agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "captcha", description: "A 'Verify you are human' check replaced the page.", got_in_the_way: true }] }).answer!;
const noAnswer = (): AgentAnswer => agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page" }).answer!;

/** One stage result per answer; null stands for a run that timed out. */
function runs(...answers: (AgentAnswer | null)[]): AgentStageResult {
  return mergeAgentRuns(
    answers.map((a, i) =>
      a
        ? { ok: true, runId: `r${i + 1}`, status: "COMPLETED", numSteps: 4, query: "q", answer: a, calls: [{ endpoint: "agent", purpose: "Answerability run result", ms: 1, ok: true }] }
        : { ok: false, runId: `r${i + 1}`, status: "TIMEOUT", error: "Agent run did not finish in 240s and was cancelled.", query: "q", answer: null, calls: [] },
    ),
  );
}

const report = (a: AgentStageResult) => buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: a }), { url: PAGE_URL });

describe("merging the runs", () => {
  it("keeps every run and numbers the calls, so the call log tells them apart", () => {
    const m = runs(answered(), captcha(), answered());
    expect(m.runs).toHaveLength(3);
    expect(m.calls.map((c) => c.purpose)).toEqual(["Answerability run 1 of 3 result", "Answerability run 2 of 3 result", "Answerability run 3 of 3 result"]);
  });

  it("returns a single run as it is", () => {
    const one = runs(answered());
    expect(one.runs).toBeUndefined();
    expect(report(one).findings.find((f) => f.id === "answer-runs-differ")).toBeUndefined();
  });
});

describe("the report with several runs", () => {
  it("uses the most common result and flags a CAPTCHA that only some visits got (Medium)", () => {
    const r = report(runs(answered(), captcha(), answered()));
    expect(r.scores.answerability).toBe("answered");
    const f = r.findings.find((x) => x.id === "answer-runs-differ")!;
    expect(f.severity).toBe("medium");
    expect(f.title).toBe("AI agent results differ between runs: answered in 2 of 3 and blocked in 1 of 3");
    expect(f.evidence).toContain("Run 2: blocked (a CAPTCHA), 4 steps.");
    expect(f.fix.steps.join(" ")).toContain("Do not challenge readers on content pages");
    expect(r.connection.join(" ")).toContain(
      "The agent ran 3 times on the same question and the results differed: answered in 2 and blocked in 1. This report uses the most common result. The site seems to challenge some visits and not others.",
    );
    expect(checkReport(r)).toEqual([]);
  });

  it("reports the block when most runs were blocked, and notes the run that got through", () => {
    const r = report(runs(captcha(), answered(), captcha()));
    expect(r.scores.answerability).toBe("not_answered");
    expect(r.findings.find((x) => x.id === "answer-blocked")!.severity).toBe("high");
    expect(r.findings.find((x) => x.id === "answer-runs-differ")!.severity).toBe("low");
    expect(checkReport(r)).toEqual([]);
  });

  it("shows the less favourable result on a tie and counts a run that did not finish", () => {
    const r = report(runs(answered(), captcha(), null));
    expect(r.scores.answerability).toBe("not_answered");
    expect(r.connection.join(" ")).toContain("the results differed: blocked in 1 and answered in 1; 1 did not finish. This report uses the most common result (the less favourable one, since they were tied).");
    expect(r.findings.find((x) => x.id === "answer-runs-differ")!.evidence).toContain("Run 3: did not finish (Agent run did not finish in 240s and was cancelled.).");
  });

  it("says there is nothing to compare when only one run finished", () => {
    const r = report(runs(answered(), null, null));
    expect(r.connection.join(" ")).toContain("Only 1 of the 3 agent runs finished, so its result could not be compared with other runs.");
    expect(r.findings.find((x) => x.id === "answer-runs-differ")).toBeUndefined();
    expect(agentAgreementNote(reportBundle(r))).toBe("Only 1 of the 3 runs finished.");
  });

  it("says so when every run agrees, and adds no finding", () => {
    const r = report(runs(answered(), answered(), answered()));
    expect(r.connection.join(" ")).toContain("The agent ran 3 times on the same question and got the same result each time.");
    expect(r.findings.find((x) => x.id === "answer-runs-differ")).toBeUndefined();
    expect(agentAgreementNote(reportBundle(r))).toBe("All 3 runs got this result.");
  });

  it("gives answer-finding advice, not bot-block advice, when runs differ only in finding the answer", () => {
    const r = report(runs(answered(), noAnswer(), answered()));
    const f = r.findings.find((x) => x.id === "answer-runs-differ")!;
    expect(f.severity).toBe("low");
    expect(f.fix.summary).toBe("Make the answer easy to find on every visit");
    expect(r.connection.join(" ")).not.toContain("challenge some visits");
  });

  it("saves the chosen run in the report's stage data, so a rebuild gives the same report", () => {
    const r = report(runs(captcha(), answered(), answered()));
    expect(r.stages.agent!.answer!.answer_found).toBe(true);
    const again = buildReport(reportBundle(r), { url: PAGE_URL });
    expect(again.scores).toEqual(r.scores);
    expect(chooseAgentRun(reportBundle(r)).agent!.runId).toBe(r.stages.agent!.runId);
  });
});

describe("which run the report shows among runs with the same result (v27 run, 2026-10-13)", () => {
  const withQuote = (q: string) => agent({ evidence_quote: q }).answer!;

  it("prefers a quote found on the page over a paraphrase (Substack)", () => {
    const r = report(runs(withQuote("The newsletter is described as having over ten thousand readers."), withQuote(QUOTE), withQuote(QUOTE)));
    expect(r.stages.agent!.runId).toBe("r2");
    expect(r.connection.join(" ")).not.toContain("paraphrased");
  });

  it("prefers a full sentence over a few words when both are on the page (tinyfish.ai)", () => {
    const r = report(runs(withQuote("Search engine optimization"), withQuote(QUOTE)));
    expect(r.stages.agent!.runId).toBe("r2");
  });

  it("keeps run order when the evidence is equally good", () => {
    expect(report(runs(withQuote(QUOTE), withQuote(QUOTE), withQuote(QUOTE))).stages.agent!.runId).toBe("r1");
  });
});

describe("starting the runs", () => {
  afterEach(() => {
    started.length = 0;
    results.clear();
    vi.useRealTimers();
    delete process.env.AGENT_RUNS;
  });

  it("starts 3 runs by default, each from a US proxy with the standard browser, and merges them", async () => {
    vi.useFakeTimers();
    results.set("run-1", answered());
    results.set("run-2", captcha());
    results.set("run-3", answered());
    const p = runAgentStage(PAGE_URL, "q", { location: "US" });
    await vi.advanceTimersByTimeAsync(6000);
    const res = await p;
    expect(started).toHaveLength(3);
    for (const body of started) {
      expect(body.proxy_config).toEqual({ enabled: true, country_code: "US" });
      expect(body.browser_profile).toBe("lite");
    }
    expect(res.runs!.map((r) => r.runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect(res.calls.filter((c) => c.purpose.startsWith("Start answerability run")).map((c) => c.purpose)).toEqual([
      "Start answerability run 1 of 3 (run-async)",
      "Start answerability run 2 of 3 (run-async)",
      "Start answerability run 3 of 3 (run-async)",
    ]);
  });

  it("reads the run count from AGENT_RUNS, between 1 and 5", () => {
    expect(agentRunCount(undefined)).toBe(3);
    expect(agentRunCount("1")).toBe(1);
    expect(agentRunCount("9")).toBe(5);
    expect(agentRunCount("0")).toBe(1);
    expect(agentRunCount("lots")).toBe(3);
  });

  it("uses the audit's country for the proxy when TinyFish covers it, and no proxy otherwise", () => {
    expect(agentProxy(undefined)).toEqual({ enabled: true, country_code: "US" });
    expect(agentProxy("gb")).toEqual({ enabled: true, country_code: "GB" });
    expect(agentProxy("IN")).toBeUndefined();
  });
});

describe("the web app polls every run", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts the runs through the server, polls each one, and merges them into the report", async () => {
    vi.useFakeTimers();
    const { runAuditInBrowser } = await import("../lib/client/runAudit");
    const answers: Record<string, AgentAnswer> = { a: answered(), b: captcha(), c: answered() };
    const polled: string[] = [];
    vi.stubGlobal("fetch", async (path: string, init?: { body?: string }) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (path === "/api/audit/fetch") return ok(fetchStage(LONG_TEXT));
      if (path === "/api/audit/search") return ok(search(2));
      if (path === "/api/audit/agent/start") {
        expect(JSON.parse(init!.body!).location).toBe("US");
        return ok({ runs: ["a", "b", "c"].map((runId) => ({ runId, calls: [{ endpoint: "agent", purpose: "Start answerability run (run-async)", ms: 1, ok: true }] })) });
      }
      const id = new URL(path, "http://x").searchParams.get("runId")!;
      polled.push(id);
      return ok({ ok: true, runId: id, status: "COMPLETED", numSteps: 4, query: "q", answer: answers[id], calls: [] });
    });
    const p = runAuditInBrowser({ url: PAGE_URL, query: "q", location: "US" }, { useBrowser: false, useAgent: true, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(6000);
    const r = await p;
    expect(polled.sort()).toEqual(["a", "b", "c"]);
    expect(r.stages.agent!.runs).toHaveLength(3);
    expect(r.scores.answerability).toBe("answered");
    expect(r.findings.find((x) => x.id === "answer-runs-differ")!.title).toContain("blocked in 1 of 3");
  });
});
