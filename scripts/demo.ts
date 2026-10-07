// Runs the audit on every page in demo-pages.json (or a file passed as the first argument)
// and writes one report per page plus demo-reports/index.md comparing them.
// Usage: npm run demo [-- pages.json] [--no-agent] [--no-browser]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./env";
import { runFullAudit } from "../lib/orchestrate";
import { reportToMarkdown } from "../lib/analyze/markdownReport";
import { slugForUrl as slugFor } from "../lib/url";

loadEnv();

async function main() {
  const file = process.argv.slice(2).find((a) => a.endsWith(".json")) || "demo-pages.json";
  const pages: { url: string; query?: string; why?: string }[] = JSON.parse(readFileSync(file, "utf8"));
  const out = "demo-reports";
  mkdirSync(out, { recursive: true });
  const rows: string[] = [];
  for (const [i, p] of pages.entries()) {
    // Spread runs out to stay inside per-minute Search and Fetch limits on free tiers.
    if (i > 0) await new Promise((r) => setTimeout(r, 20_000));
    console.log(`\n${p.url}`);
    const started = Date.now();
    try {
      const r = await runFullAudit(
        { url: p.url, query: p.query, location: "US" },
        { skipAgent: process.argv.includes("--no-agent"), skipBrowser: process.argv.includes("--no-browser"), onProgress: (m) => console.log(`  ${m}`) },
      );
      const slug = slugFor(p.url);
      writeFileSync(join(out, `${slug}.md`), reportToMarkdown(r));
      const top = r.findings.find((f) => f.severity !== "info");
      rows.push(
        `| [${p.url}](${slug}.md) | ${r.query} | ${r.scores.readability} | ${r.scores.visibility ?? "n/a"} | ${r.scores.answerability.replace(/_/g, " ")} | ${r.views.rawWords ?? "n/a"} / ${r.views.renderedWords ?? "n/a"} / ${r.views.extractedWords ?? "n/a"} | ${top ? `${top.severity}: ${top.title.replace(/\|/g, "/")}` : "none"} | ${Math.round((Date.now() - started) / 1000)}s |`,
      );
    } catch (err) {
      rows.push(`| ${p.url} | ${p.query ?? ""} | error | | | | ${(err as Error).message.replace(/\|/g, "/")} | |`);
    }
  }
  const index = [
    "# Demo run",
    "",
    `Run at ${new Date().toISOString()} against live pages.`,
    "",
    "| Page | Query | Readability | Visibility | Agent answer | Words: raw / rendered / extracted | Top finding | Time |",
    "| :- | :- | -: | -: | :- | :- | :- | -: |",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(out, "index.md"), index);
  console.log(`\nWrote ${out}/index.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
