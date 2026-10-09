// robots.txt can come from two places: TinyFish Fetch (markdown, part of the first batch) and TinyFish
// Browser (plain text read from inside the loaded page). The plain-text copy keeps the file's line
// breaks exactly as served, so when it parses it is the one the report uses.

import type { RobotsVerdict } from "../types";
import type { StageBundle } from "./findings";
import { robotsVerdicts } from "../parse/robots";
import { looksLikeChallengeText } from "../parse/html";

function sameVerdicts(a: RobotsVerdict[], b: RobotsVerdict[]): boolean {
  return a.length === b.length && a.every((v, i) => v.bot.token === b[i].bot.token && v.allowed === b[i].allowed);
}

export function withBrowserRobots(b: StageBundle): StageBundle {
  const f = b.fetch;
  const r = b.browser?.robotsTxt;
  if (!f || !r || r.status === null || f.robots.source === "browser") return b;
  const pageUrl = f.page?.finalUrl || b.browser?.finalUrl || b.url;

  if ((r.status === 404 || r.status === 410) && f.robots.status === "unreadable") {
    const v = robotsVerdicts(null, pageUrl);
    return {
      ...b,
      fetch: {
        ...f,
        robots: {
          ...f.robots,
          found: false,
          url: r.url,
          note: `No robots.txt (HTTP ${r.status}, read through TinyFish Browser). All crawlers are allowed by default.`,
          verdicts: v.verdicts,
          sitemaps: [],
          status: "absent",
          source: "browser",
        },
      },
    };
  }

  if (r.status !== 200 || !r.text.trim()) return b;
  if (/html/i.test(r.contentType ?? "") || /<html|<body/i.test(r.text) || looksLikeChallengeText(r.text)) return b;
  let v: ReturnType<typeof robotsVerdicts>;
  try {
    v = robotsVerdicts(r.text, pageUrl);
  } catch {
    return b;
  }
  if (v.validLines === 0) return b;

  const fetchNote = f.robots.reflowed ? " Fetch's copy had lost its line breaks." : "";
  const note =
    (f.robots.status !== "parsed"
      ? "Read as plain text through TinyFish Browser, because the copy Fetch returned could not be parsed. Parsed with RFC 9309 matching."
      : sameVerdicts(f.robots.verdicts, v.verdicts)
        ? "Parsed with RFC 9309 matching (plain text read through TinyFish Browser; Fetch's copy gives the same result)."
        : "Read as plain text through TinyFish Browser and parsed with RFC 9309 matching. The copy Fetch returned gave different results, so the plain-text copy is used.") + fetchNote;

  // A sitemap declared in the plain-text copy that Fetch never saw: say it exists instead of "no sitemap".
  const sitemap =
    !f.sitemap.checkedUrl && v.sitemaps.length
      ? { checkedUrl: v.sitemaps[0], containsUrl: null, note: `Sitemap declared in robots.txt (${v.sitemaps[0]}); not read in this run.` }
      : f.sitemap;

  return {
    ...b,
    fetch: {
      ...f,
      robots: { found: true, url: r.url, note, verdicts: v.verdicts, sitemaps: v.sitemaps, status: "parsed", source: "browser", reflowed: v.reflowed },
      sitemap,
    },
  };
}
