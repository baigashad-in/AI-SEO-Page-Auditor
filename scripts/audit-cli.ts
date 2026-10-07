// Usage:
//   npm run audit -- https://example.com/page --query "target query" [--location US] [--no-browser] [--no-agent] [--out reports]
// Writes <out>/<slug>.md and <out>/<slug>.json and prints the summary.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./env";
import { runFullAudit } from "../lib/orchestrate";
import { reportToMarkdown } from "../lib/analyze/markdownReport";
import { slugForUrl as slugFor } from "../lib/url";

loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const valued = new Set(["--query", "--location", "--out"]);
  const args = process.argv.slice(2);
  const url = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  if (!url) {
    console.error('Usage: npm run audit -- <url> [--query "target query"] [--location US] [--no-browser] [--no-agent] [--out reports]');
    process.exit(1);
  }
  if (!process.env.TINYFISH_API_KEY) {
    console.error("TINYFISH_API_KEY is not set. Put it in .env.local.");
    process.exit(1);
  }
  const out = arg("out") || "reports";
  const report = await runFullAudit(
    { url, query: arg("query"), location: arg("location") || "US" },
    { skipBrowser: process.argv.includes("--no-browser"), skipAgent: process.argv.includes("--no-agent"), onProgress: (m) => console.log(`  ${m}`) },
  );
  mkdirSync(out, { recursive: true });
  const base = join(out, slugFor(url));
  writeFileSync(`${base}.md`, reportToMarkdown(report));
  const { screenshot: _s, ...browserNoShot } = report.stages.browser ?? ({} as Record<string, unknown>);
  writeFileSync(`${base}.json`, JSON.stringify({ ...report, stages: { ...report.stages, browser: report.stages.browser ? browserNoShot : null } }, null, 2));

  console.log(`\nReadability ${report.scores.readability}/100, visibility ${report.scores.visibility ?? "n/a"}/100, answer test: ${report.scores.answerability}`);
  for (const line of report.connection) console.log(`* ${line}`);
  console.log("\nDo today:");
  report.doToday.forEach((id, i) => {
    const f = report.findings.find((x) => x.id === id)!;
    console.log(`${i + 1}. [${f.severity}] ${f.title}`);
  });
  console.log(`\nSaved ${base}.md and ${base}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
