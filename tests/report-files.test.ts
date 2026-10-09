// Saved reports are named after the page and the run time, so files from different runs never mix.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportFileBase, stampForFile } from "../lib/url";
import { saveReport } from "../scripts/save";
import type { AuditReport } from "../lib/types";

describe("report file names", () => {
  it("carry the run time in UTC, matching generatedAt", () => {
    expect(stampForFile("2026-10-08T19:54:34.036Z")).toBe("2026-10-08-195434");
    expect(reportFileBase("https://medium.com/blog", "2026-10-08T19:54:34.036Z")).toBe("ai-audit-medium-com-blog-2026-10-08-195434");
    expect(stampForFile("not a date")).toBe("undated");
  });

  it("saves the Markdown and the JSON side by side, without the screenshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const report = {
      generatedAt: "2026-10-09T10:30:12.000Z",
      input: { url: "https://example.com/page" },
      query: "q",
      queryDerived: false,
      scores: { readability: 50, visibility: null, answerability: "unknown", quadrant: "unknown", readabilityParts: [], visibilityParts: [] },
      connection: [],
      findings: [],
      strengths: [],
      doToday: [],
      views: { blockedNote: null, rawWords: null, renderedWords: null, extractedWords: null, rawSample: "", extractedSample: "" },
      calls: [],
      stages: { fetch: null, browser: { screenshot: "data:image/jpeg;base64,AAAA" }, search: null, agent: null },
    } as unknown as AuditReport;
    const saved = saveReport(dir, report);
    expect(readdirSync(dir).sort()).toEqual(["ai-audit-example-com-page-2026-10-09-103012.json", "ai-audit-example-com-page-2026-10-09-103012.md"]);
    const json = JSON.parse(readFileSync(saved.json, "utf8"));
    expect(json.generatedAt).toBe("2026-10-09T10:30:12.000Z");
    expect(json.stages.browser.screenshot).toBeNull();
  });
});
