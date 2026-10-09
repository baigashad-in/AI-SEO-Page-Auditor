// Saves a report as Markdown and JSON next to each other, named after the page and the run time
// (ai-audit-<page>-<run time>.md / .json), so files from different runs never overwrite or mix.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditReport } from "../lib/types";
import { reportToMarkdown } from "../lib/analyze/markdownReport";
import { reportFileBase } from "../lib/url";

/** Writes both files into dir and returns their paths. The JSON leaves out the screenshot to stay small. */
export function saveReport(dir: string, report: AuditReport): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, reportFileBase(report.input.url, report.generatedAt));
  writeFileSync(`${base}.md`, reportToMarkdown(report));
  const b = report.stages.browser;
  const browser = b ? { ...b, screenshot: null } : null;
  writeFileSync(`${base}.json`, JSON.stringify({ ...report, stages: { ...report.stages, browser } }, null, 2));
  return { md: `${base}.md`, json: `${base}.json` };
}
