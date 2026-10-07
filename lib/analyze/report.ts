// Turns the four stage results into the final report: scores, the readability-to-visibility
// connection, findings, and the "do today" list.

import type { AuditReport, CallLog, Scores } from "../types";
import { buildFindings, buildStrengths, type StageBundle } from "./findings";
import { markdownToPlain } from "../parse/markdown";
import { quoteAppearsIn, truncate } from "./text";
import { rootDomain } from "../url";

function clamp(n: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, n));
}

export function computeScores(b: StageBundle): Scores {
  const f = b.fetch;
  const br = b.browser;
  const s = b.search;
  const parts: { label: string; score: number; max: number }[] = [];

  // 1. Crawler access (30)
  if (f || br) {
    let a = 30;
    if (f?.pageError) a -= 30;
    const robotsMeta = [br?.raw?.metaRobots, br?.rendered?.metaRobots, br?.headers.xRobotsTag].join(" ").toLowerCase();
    if (/noindex/.test(robotsMeta)) a -= 30;
    const blocked = f?.robots.verdicts.filter((v) => !v.allowed) ?? [];
    if (blocked.some((v) => v.bot.purpose === "classic_search")) a -= 15;
    a -= Math.min(24, blocked.filter((v) => v.bot.purpose === "ai_search").length * 8);
    a -= Math.min(16, (br?.botProbes.filter((p) => p.verdict === "blocked").length ?? 0) * 8);
    parts.push({ label: "Crawler access", score: Math.round(clamp(a, 0, 30)), max: 30 });
  }

  // 2. Works without JavaScript (25)
  if (br?.raw && br.rendered) {
    const ratio = br.rendered.words > 0 ? br.raw.words / br.rendered.words : 1;
    let r = 25 * clamp(ratio / 0.9);
    const js = br.onlyAfterJs;
    const titleRewritten = !!br.raw.title && !!br.rendered.title && br.raw.title.trim() !== br.rendered.title.trim();
    r -= [js.title || titleRewritten, js.h1, js.canonical, js.description, js.jsonLd].filter(Boolean).length * 3;
    parts.push({ label: "Works without JavaScript", score: Math.round(clamp(r, 0, 25)), max: 25 });
  }

  // 3. Clean extraction (25)
  if (f?.stats) {
    let e = 0;
    if (br?.rendered && br.rendered.words > 0) e += 12 * clamp(f.stats.words / br.rendered.words / 0.5);
    else e += f.stats.words > 0 ? 12 : 0;
    e += f.stats.words >= 600 ? 8 : f.stats.words >= 300 ? 5 : f.stats.words >= 120 ? 2 : 0;
    e += f.stats.headings.length >= 3 ? 5 : f.stats.headings.length >= 1 ? 3 : 0;
    parts.push({ label: "Clean AI extraction", score: Math.round(clamp(e, 0, 25)), max: 25 });
  } else if (f?.pageError) {
    parts.push({ label: "Clean AI extraction", score: 0, max: 25 });
  }

  // 4. Metadata and structure (20)
  if (f?.page || br?.rendered) {
    const r = br?.rendered;
    let m = 0;
    if (f?.page?.title || r?.title) m += 4;
    if (f?.page?.description || r?.metaDescription) m += 4;
    if (r) {
      if (r.canonical) m += 3;
      if (r.jsonLd.blocks > 0 && r.jsonLd.parseErrors === 0) m += 4;
      if (r.htmlLang) m += 1;
      if (r.h1.length === 1) m += 2;
    } else {
      m += 5; // unknown without Browser; do not punish
    }
    const article = /Article|BlogPosting|NewsArticle/.test(r?.jsonLd.types.join(" ") || "") || r?.og.type === "article";
    if (!article || (f?.page?.author && f.page.publishedDate)) m += 2;
    parts.push({ label: "Metadata and structure", score: Math.round(clamp(m, 0, 20)), max: 20 });
  }

  const totalMax = parts.reduce((x, p) => x + p.max, 0);
  const readability = totalMax ? Math.round((parts.reduce((x, p) => x + p.score, 0) / totalMax) * 100) : 0;

  // Visibility
  const vparts: { label: string; score: number; max: number }[] = [];
  if (s && s.pagesChecked > 0) {
    const pos = s.target.position;
    const r = pos === null ? (s.domain.bestPosition ? 15 : 0) : pos <= 3 ? 70 : pos <= 10 ? 52 : 30;
    vparts.push({ label: `Rank for "${truncate(s.query, 40)}"`, score: r, max: 70 });
    if (s.indexProbe.query || pos !== null)
      vparts.push({ label: "Found in search index", score: s.indexProbe.found || pos !== null ? 30 : 0, max: 30 });
  }
  const vmax = vparts.reduce((x, p) => x + p.max, 0);
  const visibility = vmax ? Math.round((vparts.reduce((x, p) => x + p.score, 0) / vmax) * 100) : null;

  const a = b.agent?.answer;
  const answerability: Scores["answerability"] = !a
    ? "unknown"
    : !a.answer_found
      ? "not_answered"
      : a.answer_location === "visible_on_load" || a.answer_location === "after_scroll"
        ? "answered"
        : "answered_with_effort";

  const quadrant: Scores["quadrant"] =
    visibility === null ? "unknown" : readability >= 60 ? (visibility >= 40 ? "readable_visible" : "readable_invisible") : visibility >= 40 ? "unreadable_visible" : "unreadable_invisible";

  return { readability, visibility, answerability, quadrant, readabilityParts: parts, visibilityParts: vparts };
}

/** Plain-English lines that tie "can AI read it" to "does it show up". Built only from observed values. */
export function buildConnection(b: StageBundle, scores: Scores): string[] {
  const lines: string[] = [];
  const s = b.search;
  const br = b.browser;
  const f = b.fetch;
  const q = b.query;
  const pos = s?.target.position ?? null;
  const rawW = br?.raw?.words ?? null;
  const renW = br?.rendered?.words ?? null;
  const extW = f?.stats?.words ?? null;

  switch (scores.quadrant) {
    case "unreadable_visible":
      lines.push(
        `Visible but hard to read: the page ${pos ? `ranks #${pos}` : "is present"} for "${q}", but scores ${scores.readability}/100 on AI readability. Classic rankings do not carry over to AI answers if the answer engine's crawler cannot read the text, so this is where the fastest gains are.`,
      );
      break;
    case "readable_invisible":
      lines.push(
        `Readable but not visible: AI tools can read this page (${scores.readability}/100), but it does not show up for "${q}". Readability is not the bottleneck; relevance, coverage and links are. Start with the visibility and content-gap findings.`,
      );
      break;
    case "unreadable_invisible":
      lines.push(
        `Neither readable nor visible for "${q}" (readability ${scores.readability}/100). Fix readability first: neither search engines nor AI tools can rank or cite text they cannot read.`,
      );
      break;
    case "readable_visible":
      lines.push(`Readable (${scores.readability}/100) and visible${pos ? ` (#${pos})` : ""} for "${q}". The job now is to stay quotable: keep the answer early, specific and in the server HTML.`);
      break;
    default:
      lines.push(`AI readability: ${scores.readability}/100. Search visibility was not measured in this run.`);
  }

  if (rawW !== null && renW !== null && renW >= 120) {
    const ratio = rawW / renW;
    if (ratio < 0.7)
      lines.push(
        `Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) receive ${rawW} words; a browser shows ${renW}. ${pos ? `Your current #${pos} ranking is likely carried by Google, which renders JavaScript; ChatGPT, Claude and Perplexity are working from the ${rawW}-word version.` : "Those engines index the smaller version, which makes ranking and citation less likely."}`,
      );
    else lines.push(`The server HTML already carries ${Math.round(ratio * 100)}% of the visible text, so crawlers that skip JavaScript see essentially the same page as users.`);
  }

  const blockedSearch = f?.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "ai_search") ?? [];
  if (blockedSearch.length) lines.push(`robots.txt excludes ${blockedSearch.map((v) => v.bot.operator).join(", ")} search crawlers, so this page cannot appear in those answer engines regardless of its Google ranking.`);
  const edge = br?.botProbes.filter((p) => p.verdict === "blocked") ?? [];
  if (edge.length)
    lines.push(
      `Requests sent with the ${edge.map((p) => p.bot).join(", ")} user-agent got a block or challenge page from your server or CDN. If the real crawler is blocked too, that engine cannot index the page at all, whatever robots.txt says.`,
    );

  const comps = s?.competitors.filter((c) => c.fetched && c.stats) ?? [];
  if (comps.length >= 2 && extW !== null) {
    const words = comps.map((c) => c.stats!.words).sort((x, y) => x - y);
    const median = words[Math.floor(words.length / 2)];
    lines.push(`The pages ${pos ? "around" : "ranking for"} this query give AI tools a median of ${median} extractable words (${comps.map((c) => rootDomain(c.url)).join(", ")}); this page gives ${extW}.`);
  }

  const a = b.agent?.answer;
  if (a) {
    if (!a.answer_found) lines.push(`An AI browsing agent asked "${q}" on the live page could not find an answer${a.missing_information.length ? `; it reported missing: ${a.missing_information.slice(0, 3).join("; ")}` : ""}.`);
    else if (a.evidence_quote && f?.page) {
      const inFetch = quoteAppearsIn(a.evidence_quote, markdownToPlain(f.page.markdown));
      const inRaw = br?.raw ? quoteAppearsIn(a.evidence_quote, br.raw.text) : null;
      const where = a.answer_location.replace(/_/g, " ");
      const seenBy = [inFetch ? "fetch tools" : null, inRaw ? "non-JavaScript crawlers" : null].filter(Boolean);
      const missedBy = [!inFetch ? "fetch tools" : null, inRaw === false ? "non-JavaScript crawlers" : null].filter(Boolean);
      lines.push(
        missedBy.length
          ? `An AI browsing agent answered "${q}" (${where}), but ${missedBy.join(" and ")} never receive that answer${seenBy.length ? `; ${seenBy.join(" and ")} do` : ""}. Answer engines can only quote what they receive.`
          : `An AI browsing agent answered "${q}" (${where}), and the same answer is in what fetch tools and non-JavaScript crawlers receive.`,
      );
    }
  }

  lines.push("Rankings come from TinyFish Search, which runs its own index; treat positions as directional, not as Google positions.");
  return lines;
}

export function buildReport(b: StageBundle, input: { url: string; query?: string; location?: string }): AuditReport {
  const scores = computeScores(b);
  const findings = buildFindings(b);
  const doToday = findings
    // Only things worth doing today: low and info findings stay in the full list.
    .filter((f) => f.severity === "critical" || f.severity === "high" || (f.severity === "medium" && f.fix.effort !== "days"))
    .slice(0, 5)
    .map((f) => f.id);
  const calls: CallLog[] = [...(b.fetch?.calls ?? []), ...(b.browser?.calls ?? []), ...(b.search?.calls ?? []), ...(b.agent?.calls ?? [])];
  const extracted = b.fetch?.page ? markdownToPlain(b.fetch.page.markdown).replace(/\s+/g, " ").trim() : "";
  return {
    generatedAt: new Date().toISOString(),
    input,
    query: b.query,
    queryDerived: b.queryDerived,
    scores,
    connection: buildConnection(b, scores),
    findings,
    strengths: buildStrengths(b),
    doToday,
    views: {
      rawWords: b.browser?.raw?.words ?? null,
      renderedWords: b.browser?.rendered?.words ?? null,
      extractedWords: b.fetch?.stats?.words ?? null,
      rawSample: truncate(b.browser?.raw?.text ?? "", 700),
      extractedSample: truncate(extracted, 700),
    },
    calls,
    stages: { fetch: b.fetch, browser: b.browser, search: b.search, agent: b.agent },
  };
}
