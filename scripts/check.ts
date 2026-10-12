// Checks saved reports against the rules in lib/analyze/consistency.ts. No TinyFish calls, no API key.
// Usage:
//   npm run check                     the newest run in demo-reports/
//   npm run check -- --all            every run in demo-reports/
//   npm run check -- <folder|file.json> ...
//   add --rebuild to analyze each report's saved stage data again with the current code first,
//   which shows whether an update fixes reports saved by an older version.
// Exits with code 1 when a rule is broken, so it can gate a demo run or CI.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkReport, RULES } from "../lib/analyze/consistency";
import { buildReport } from "../lib/analyze/report";
import { pageUrlAfterRedirect } from "../lib/url";
import type { AuditReport } from "../lib/types";

const DEMO_DIR = "demo-reports";

function jsonFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith(".json") ? [path] : [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => jsonFiles(join(path, name)));
}

function targets(args: string[]): { files: string[]; label: string } {
  const paths = args.filter((a) => !a.startsWith("--"));
  if (paths.length) {
    const files = paths.flatMap(jsonFiles);
    // Name folders; for loose files just count them, so the summary line stays short.
    const folders = paths.filter((p) => existsSync(p) && statSync(p).isDirectory());
    return { files, label: folders.length === paths.length ? folders.join(", ") : `${files.length} file${files.length === 1 ? "" : "s"} given` };
  }
  if (args.includes("--all")) return { files: jsonFiles(DEMO_DIR), label: `every run in ${DEMO_DIR}/` };
  // Run folders are named after the run time (2026-10-12-000434), so the last one by name is the newest.
  const runs = existsSync(DEMO_DIR) ? readdirSync(DEMO_DIR).filter((n) => statSync(join(DEMO_DIR, n)).isDirectory()).sort() : [];
  const newest = runs[runs.length - 1];
  return newest ? { files: jsonFiles(join(DEMO_DIR, newest)), label: join(DEMO_DIR, newest) } : { files: [], label: `${DEMO_DIR}/` };
}

/** The saved report, or with --rebuild the report the current code makes from the same stage data. */
function load(file: string, rebuild: boolean): AuditReport | null {
  const saved = JSON.parse(readFileSync(file, "utf8")) as AuditReport;
  if (!saved?.stages || !Array.isArray(saved.findings)) return null; // not a report (index files, other JSON)
  if (!rebuild) return saved;
  const st = structuredClone(saved.stages);
  // Reports saved before 2026-10-09 kept challenge-redirect query strings in Fetch's final URL.
  if (st.fetch?.page) st.fetch.page.finalUrl = pageUrlAfterRedirect(st.fetch.page.url, st.fetch.page.finalUrl);
  const r = buildReport({ ...st, query: saved.query, queryDerived: saved.queryDerived, url: saved.input.url }, saved.input);
  return { ...r, generatedAt: saved.generatedAt, calls: saved.calls };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--rules")) {
    for (const r of RULES) console.log(`${r.id}: ${r.says}`);
    return;
  }
  const rebuild = args.includes("--rebuild");
  const { files, label } = targets(args);
  if (!files.length) {
    console.error(`No saved reports found in ${label}. Run \`npm run demo\` first, or pass a folder or .json files.`);
    process.exit(1);
  }

  let checked = 0;
  let broken = 0;
  let problems = 0;
  for (const file of files) {
    let r: AuditReport | null;
    try {
      r = load(file, rebuild);
    } catch (err) {
      console.log(`skip ${relative(".", file)}: ${(err as Error).message}`);
      continue;
    }
    if (!r) continue;
    checked++;
    const found = checkReport(r);
    const when = r.generatedAt.slice(0, 16).replace("T", " ");
    if (!found.length) {
      console.log(`ok   ${r.input.url}  (${when})`);
      continue;
    }
    broken++;
    problems += found.length;
    console.log(`FAIL ${r.input.url}  (${when})`);
    for (const v of found) console.log(`     ${v.rule}: ${v.message}`);
  }

  console.log(`\nChecked ${checked} report${checked === 1 ? "" : "s"} in ${label} ${rebuild ? "(analyzed again with the current code)" : "(as saved)"} against ${RULES.length} rules.`);
  if (!problems) {
    console.log("No rule is broken.");
    return;
  }
  console.log(`${problems} broken rule${problems === 1 ? "" : "s"} in ${broken} report${broken === 1 ? "" : "s"}.${rebuild ? "" : " Add --rebuild to see whether the current code fixes them."} List the rules with --rules.`);
  process.exit(1);
}

main();
