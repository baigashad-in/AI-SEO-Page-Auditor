// Turns the four stage results into the final report: scores, the readability-to-visibility
// connection, findings, and the "do today" list.

import type { AuditReport, CallLog, Scores } from "../types";
import { agentRunsLine, agentWasBlocked, answerabilityOf, answeredOnOtherPage, chooseAgentRun, blockerPhrase, browserRenderIncomplete, buildFindings, comparedTexts, buildStrengths, isShortQuote, locateQuote, missingStages, mostlyHiddenVisibleWords, obstacles, seriousBlockers, snapshotIncomplete, usableStages, type StageBundle } from "./findings";
import { markdownToPlain } from "../parse/markdown";
import { andList, truncate } from "./text";
import { bareHost, displayUrl } from "../url";
import { AI_BOTS } from "../parse/robots";
import { withBrowserRobots } from "./robotsSource";
import { scoreNotes } from "./scoreNotes";

function clamp(n: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, n));
}

export function computeScores(input: StageBundle): Scores {
  const b = usableStages(input);
  const f = b.fetch;
  const br = b.browser;
  const s = b.search;
  const parts: { label: string; score: number; max: number }[] = [];

  // 1. Crawler access (30)
  // A failed Browser stage holds no page data, so it is not evidence of access: with the Fetch call
  // also failing, crawler access scored 30 of 30 and readability 100 from nothing (2026-10-14).
  if (f || br?.raw || input.browser?.challenge) {
    let a = 30;
    if (f?.pageError) a -= 30;
    if (input.browser?.challenge) a -= 10; // AI browsing agents meet the same challenge
    if (input.browser?.rawChallenge) a -= 10; // crawlers that do not run JavaScript stop at the challenge
    const robotsMeta = [br?.raw?.metaRobots, br?.rendered?.metaRobots, br?.headers.xRobotsTag].join(" ").toLowerCase();
    if (/noindex/.test(robotsMeta)) a -= 30;
    const blocked = f?.robots.verdicts.filter((v) => !v.allowed) ?? [];
    if (blocked.some((v) => v.bot.purpose === "classic_search")) a -= 15;
    a -= Math.min(24, blocked.filter((v) => v.bot.purpose === "ai_search").length * 8);
    const searchBlocked = br?.botProbes.filter((p) => p.verdict === "blocked" && AI_BOTS.find((x) => x.token === p.bot)?.purpose !== "training").length ?? 0;
    a -= Math.min(24, searchBlocked * 8);
    parts.push({ label: "Crawler access", score: Math.round(clamp(a, 0, 30)), max: 30 });
  }

  // 2. Works without JavaScript (25)
  if (br?.raw && br.rendered) {
    // When the browser's render missed text Fetch got, the page holds at least raw + that text.
    const gap = browserRenderIncomplete(b);
    const snap = gap ? null : snapshotIncomplete(b);
    const fullWords = gap ? Math.max(br.rendered.words, br.raw.words + gap.notInRaw.words) : snap ? snap.shownWords : br.rendered.words;
    const ratio = fullWords > 0 ? br.raw.words / fullWords : 1;
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

  const answerability = answerabilityOf(input, b.agent?.answer ?? null);

  const ranks = s?.target.position != null;
  const quadrant: Scores["quadrant"] =
    visibility === null || !parts.length ? "unknown" : readability >= 60 ? (ranks ? "readable_visible" : "readable_invisible") : ranks ? "unreadable_visible" : "unreadable_invisible";

  return { readability, visibility, answerability, quadrant, readabilityParts: parts, visibilityParts: vparts, missingStages: missingStages(input) };
}

/**
 * "pricingsaas.com (3 pages), en.wikipedia.org" instead of repeating a host once per page. Hosts, not
 * root domains, so newsletter.pricingsaas.com stays apart from pricingsaas.com, as in the findings.
 */
export function domainList(urls: string[]): string {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const d = bareHost(u) || u;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()].map(([d, n]) => (n > 1 ? `${d} (${n} pages)` : d)).join(", ");
}

/** Plain-English lines that tie "can AI read it" to "does it show up". Built only from observed values. */
export function buildConnection(input: StageBundle, scores: Scores): string[] {
  const lines: string[] = [];
  const b = usableStages(input);
  const s = b.search;
  const br = b.browser;
  const f = b.fetch;
  const q = b.query;
  const pos = s?.target.position ?? null;
  const rawW = br?.raw?.words ?? null;
  const renW = br?.rendered?.words ?? null;
  // Rendered counts include hidden text; name the visible share when much of it is hidden.
  const vis = mostlyHiddenVisibleWords(b);
  // AI search crawler user-agents the server or CDN answered with a block page. When there are any,
  // crawlers do not simply "receive" the server HTML: some get the block page (Medium, 2026-10-13).
  const edge = br?.botProbes.filter((p) => p.verdict === "blocked" && AI_BOTS.find((x) => x.token === p.bot)?.purpose !== "training") ?? [];
  const receive = edge.length ? "get at most" : "receive";
  const atBest = edge.length ? " at best" : "";
  const extW = f?.stats?.words ?? null;
  const partial = !!scoreNotes(scores).readability;
  const rd = `${scores.readability}/100${partial ? ", partial score" : ""}`; // inside parentheses

  switch (scores.quadrant) {
    case "unreadable_visible":
      lines.push(
        `Visible but hard to read: the page ranks #${pos} for "${q}", but scores ${scores.readability}/100 on AI readability${partial ? " (partial score)" : ""}. Classic rankings do not carry over to AI answers if the answer engine's crawler cannot read the text, so this is where the fastest gains are.`,
      );
      break;
    case "readable_invisible":
      lines.push(
        `Readable but not visible: AI tools can read this page (${rd}), but it does not show up for "${q}". Readability is not the bottleneck; relevance, coverage and links are. Start with the visibility and content-gap findings.`,
      );
      break;
    case "unreadable_invisible":
      lines.push(
        `Neither readable nor visible for "${q}" (readability ${rd}). Fix readability first: neither search engines nor AI tools can rank or cite text they cannot read.`,
      );
      break;
    case "readable_visible":
      lines.push(`Readable (${rd}) and visible${pos ? ` (#${pos})` : ""} for "${q}". The job now is to stay quotable: keep the answer early, specific and in the server HTML.`);
      break;
    default:
      if (!scores.readabilityParts.length)
        lines.push(
          scores.visibility === null
            ? "Neither AI readability nor search visibility could be measured in this run; \"Some checks did not run\" says why."
            : `AI readability could not be measured in this run (Fetch and the browser did not read the page), so it cannot be compared with search visibility (${scores.visibility}/100).`,
        );
      else lines.push(`AI readability: ${scores.readability}/100${partial ? " (partial score)" : ""}. Search visibility was not measured in this run.`);
  }
  const other = pos === null ? s?.domain.urls[0] : undefined;
  if (other) {
    // No period after a shortened URL, so the line does not end in "?…."
    const shown = displayUrl(other.url);
    lines.push(`Another page on the same site ranks #${other.position} for "${q}" instead: ${shown}${shown.endsWith("\u2026") ? "" : "."}`);
  }
  if (input.browser?.challenge) {
    const title = input.browser.challenge.title ? ` ("${input.browser.challenge.title}")` : "";
    // An agent that met no challenge shows the wall is not there for every visitor (Reddit, 2026-10-13:
    // the remote browser was challenged, all 3 agent runs read the page).
    const ag = input.agent?.answer;
    lines.push(
      ag && !agentWasBlocked(ag)
        ? `A real browser received a bot challenge page${title} instead of the content, so browser-based checks were skipped. The AI browsing agent reached the content without a challenge, so the challenge does not stop every visitor; it depends on how the visitor connects.`
        : `A real browser received a bot challenge page${title} instead of the content, so AI browsing agents are likely to hit the same wall. Browser-based checks were skipped.`,
    );
  }
  if (f?.robots.status === "unreadable") lines.push("robots.txt came back unreadable, so whether AI crawlers are allowed is unknown from this run.");
  const rc = input.browser?.rawChallenge;

  const gap = browserRenderIncomplete(b);
  const snap = gap ? null : snapshotIncomplete(b);
  if (gap && gap.notInRaw.words >= 40 && rawW !== null && !rc) {
    lines.push(
      `Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) ${receive} ${rawW} words. TinyFish Fetch extracted ${gap.fetchWords}, with ${gap.notInRaw.words} words in lines that HTML does not contain, so much of the page text arrives through JavaScript. The remote browser's render was incomplete this run (${renW} words), so Fetch's text is the better guide.`,
    );
  } else if (gap) {
    lines.push(`The remote browser's render was incomplete this run: it had ${renW} words, while Fetch extracted ${gap.fetchWords}. Browser-based checks may understate the page.`);
  } else if (snap && rawW !== null && !rc) {
    lines.push(
      `The remote browser saved the page before it finished loading (${snap.savedWords} words saved, ${snap.shownWords} shown), so browser-based checks may understate the page. Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) ${receive} ${rawW} words.`,
    );
  } else if (rc && !input.browser?.challenge) {
    lines.push(
      `The first HTML response is a bot challenge (${rc.reason}); a browser gets through after JavaScript runs${renW !== null ? `, and the page then has ${renW} words${vis ? ` (${vis} of them visible)` : ""}` : ""}. Crawlers that skip JavaScript (GPTBot, ClaudeBot, PerplexityBot) stop at the challenge, so those engines have nothing to index.`,
    );
  } else if (rawW !== null && renW !== null && renW >= 120) {
    const ratio = rawW / renW;
    if (ratio < 0.7)
      lines.push(
        `Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) ${receive} ${rawW} words; after JavaScript the page has ${renW}${vis ? ` (${vis} of them visible)` : ""}. ${pos ? `The page still ranks #${pos} in TinyFish Search, but ChatGPT, Claude and Perplexity crawlers work from the ${rawW}-word version${atBest}.` : `Those engines index the smaller version${atBest}, which makes ranking and citation less likely.`}`,
      );
    // Rendered text, not visible text: both counts include hidden text, so they compare like with like.
    else if (ratio >= 0.9) lines.push(`The server HTML already carries ${Math.round(ratio * 100)}% of the rendered text, so crawlers that skip JavaScript see essentially the same page as users.`);
    else {
      // 70 to 90%: name what JavaScript adds, so the reader can tell a banner from content (Wikipedia's
      // fundraising banner, 2026-10-11, added "Donor-Advised Fund (DAF)" and similar headings).
      const late = [...new Set(input.browser?.onlyAfterJs.headings ?? [])].slice(0, 2).map((h) => `"${truncate(h, 60)}"`);
      lines.push(
        `The server HTML carries ${Math.round(ratio * 100)}% of the rendered text; JavaScript adds the rest${late.length ? `, including ${andList(late)}` : ""}. If that is content you want AI tools to quote, put it in the server HTML.`,
      );
    }
  }

  const blockedSearch = f?.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "ai_search") ?? [];
  const classicBlocked = f?.robots.verdicts.some((v) => !v.allowed && v.bot.purpose === "classic_search") ?? false;
  const indexedAnyway = classicBlocked && (pos !== null || !!s?.indexProbe.found);
  if (blockedSearch.length)
    lines.push(
      indexedAnyway
        ? `robots.txt, as served to TinyFish, excludes the ${andList(blockedSearch.map((v) => v.bot.operator))} search crawlers. The page still ranks, so the site may treat verified crawlers differently; if those engines get the same file, the page cannot appear in their answers.`
        : `robots.txt excludes the ${andList(blockedSearch.map((v) => v.bot.operator))} search crawlers, so this page cannot appear in those answer engines regardless of its Google ranking.`,
    );
  if (edge.length)
    lines.push(
      edge.length > 1
        ? `Requests sent with the ${andList(edge.map((p) => p.bot))} user-agents got a block or challenge page from your server or CDN. If the real crawlers are blocked too, those engines cannot index the page at all, whatever robots.txt says.`
        : `Requests sent with the ${edge[0].bot} user-agent got a block or challenge page from your server or CDN. If the real crawler is blocked too, that engine cannot index the page at all, whatever robots.txt says.`,
    );

  const comps = s?.competitors.filter((c) => c.fetched && c.stats) ?? [];
  if (comps.length >= 2 && extW !== null) {
    const words = comps.map((c) => c.stats!.words).sort((x, y) => x - y);
    const median = words[Math.floor(words.length / 2)];
    lines.push(`The pages ${pos ? "around" : "ranking for"} this query give AI tools a median of ${median} extractable words (${domainList(comps.map((c) => c.url))}); this page gives ${extW}.`);
  }

  const a = input.agent?.answer;
  if (a) {
    // "visible on load, after getting past a CAPTCHA": the agent answered, but only after a challenge.
    const passed = seriousBlockers(a);
    const where = `${a.answer_location.replace(/_/g, " ")}${passed.length && a.answer_found ? `, after getting past ${[...new Set(passed.map(blockerPhrase))].join(" and ")}` : ""}`;
    const loc = locateQuote(input);
    if (!a.answer_found && agentWasBlocked(a)) {
      lines.push(`An AI browsing agent looking for "${q}" was blocked before it could read the page (${andList([...new Set(obstacles(a).map(blockerPhrase))])}).`);
    } else if (!a.answer_found) {
      lines.push(`An AI browsing agent looking for "${q}" on the live page could not find an answer${a.missing_information.length ? `; it reported missing: ${a.missing_information.slice(0, 3).join("; ")}` : ""}.`);
    } else if (answeredOnOtherPage(a) && !loc.verified) {
      // Only a page text that was read can show the answer is missing from this page (2026-10-14).
      lines.push(
        `An AI browsing agent found an answer to "${q}" only on another page it opened (${a.interactions_needed.join(", then ") || "a linked page"}). ` +
          (comparedTexts(loc).length
            ? "This page itself does not contain it, so answer engines would cite the other page."
            : "Fetch and the browser could not read this page, so whether it also holds the answer could not be checked."),
      );
    } else if (a.evidence_quote && !loc.verified && a.answer_location === "after_interaction") {
      const missedBy = [loc.inFetch === false ? "fetch tools" : null, loc.inRaw === false ? "non-JavaScript crawlers" : null].filter(Boolean);
      lines.push(
        `An AI browsing agent answered "${q}" only after interacting with the page (${a.interactions_needed.join(", then ") || "clicks"}); ` +
          (missedBy.length
            ? `that text is not in what ${missedBy.join(" or ")} receive.`
            : "Fetch and the browser could not read the page, so whether crawlers receive that text could not be checked."),
      );
    } else if (a.evidence_quote && !loc.verified) {
      // "Paraphrased" is only a fair conclusion when the browser read the page, since the rendered page
      // holds everything a reader sees. Medium (2026-10-14): Fetch was blocked and the Browser failed,
      // yet the summary said the quote was paraphrased; there was no page text to compare it with.
      const browserRead = loc.inRaw !== null || loc.inRendered !== null;
      if (browserRead) {
        lines.push(`An AI browsing agent answered "${q}" (${where}). Its quote was paraphrased rather than copied from the page, so which crawlers receive that text could not be checked.`);
      } else if (loc.inFetch !== null) {
        const why = input.browser?.challenge ? "the browser got a bot challenge page" : input.browser ? "the Browser stage failed" : "the Browser stage did not run";
        lines.push(
          `An AI browsing agent answered "${q}" (${where}). Its quote is not in the text Fetch extracted, and ${why}, so the quote may be paraphrased or come from page text Fetch did not keep; which crawlers receive it could not be checked.`,
        );
      } else {
        lines.push(`An AI browsing agent answered "${q}" (${where}). Neither Fetch nor the browser could read the page, so its quote could not be checked against the page text or against what crawlers receive.`);
      }
    } else if (a.evidence_quote) {
      // The server HTML is what crawlers that skip JavaScript receive, unless the edge answered the AI
      // crawler user-agents with a block page; then they receive that instead (Medium, 2026-10-13).
      const rawSeen = loc.inRaw && !edge.length;
      const seenBy = [loc.inFetch ? "fetch tools" : null, rawSeen ? "non-JavaScript crawlers" : null].filter(Boolean);
      const missedBy = [loc.inFetch === false ? "fetch tools" : null, loc.inRaw === false ? "non-JavaScript crawlers" : null].filter(Boolean);
      const edgeNote =
        loc.inRaw && edge.length
          ? `${seenBy.length ? "It is also" : "Its quote is"} in the server HTML, but the AI search crawler user-agents tested got a block page instead (see above).`
          : "";
      // A few words ("The Medium Blog") may be a heading or tagline, not the answer, wherever they appear.
      const shortNote = isShortQuote(a.evidence_quote)
        ? `The quote is short ("${truncate(a.evidence_quote, 80)}"), so it may be a heading or tagline rather than the answer; treat this as a weak signal.`
        : "";
      const tail = [edgeNote, shortNote].filter(Boolean).join(" ");
      lines.push(
        missedBy.length && isShortQuote(a.evidence_quote)
          ? // Same doubt as the finding: a few words may be a tagline, not the answer.
            `An AI browsing agent answered "${q}" (${where}) with a short quote ("${truncate(a.evidence_quote, 80)}") that ${missedBy.join(" and ")} do not receive${seenBy.length ? ` (${seenBy.join(" and ")} do)` : ""}. It may be a tagline rather than the answer, so treat this as a weak signal.${edgeNote ? ` ${edgeNote}` : ""}`
          : missedBy.length
          ? `An AI browsing agent answered "${q}" (${where}), but ${missedBy.join(" and ")} never receive that answer${seenBy.length ? `; ${seenBy.join(" and ")} do` : ""}. Answer engines can only quote what they receive.${tail ? ` ${tail}` : ""}`
          : seenBy.length
          ? `An AI browsing agent answered "${q}" (${where}), and the same answer is in what ${seenBy.join(" and ")} receive.${tail ? ` ${tail}` : ""}`
          : `An AI browsing agent answered "${q}" (${where}).${tail ? ` ${tail}` : ""}`,
      );
    }
  }

  const runsLine = agentRunsLine(input);
  if (runsLine) lines.push(runsLine);

  lines.push("Rankings come from TinyFish Search, which runs its own index; treat positions as directional, not as Google positions.");
  return lines;
}

export function buildReport(stages: StageBundle, input: { url: string; query?: string; location?: string }): AuditReport {
  // Use the plain-text robots.txt from the browser when it parses (see robotsSource.ts).
  // With several agent runs, every score and finding uses the most common result (see chooseAgentRun).
  const b = chooseAgentRun(withBrowserRobots(stages));
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
      blockedNote: b.browser?.challenge
        ? `TinyFish Browser received a bot challenge page${b.browser.challenge.title ? ` ("${b.browser.challenge.title}")` : ""}; browser word counts are not available.`
        : b.browser?.rawChallenge
          ? "The first HTML response was a bot challenge page, so there is no raw server HTML word count for the real page."
          : browserRenderIncomplete(b)
            ? `The remote browser's render was incomplete this run: it showed fewer words than Fetch extracted, so the rendered count understates the page.`
            : snapshotIncomplete(b)
              ? `The remote browser saved the page before it finished loading: the rendered count is from the saved HTML, while the page showed ${b.browser!.renderedInnerTextWords} words.`
              : null,
      rawWords: b.browser?.challenge || b.browser?.rawChallenge ? null : (b.browser?.raw?.words ?? null),
      renderedWords: b.browser?.challenge ? null : (b.browser?.rendered?.words ?? null),
      visibleWords: mostlyHiddenVisibleWords(b),
      extractedWords: b.fetch?.stats?.words ?? null,
      rawSample: truncate(b.browser?.raw?.text ?? "", 700),
      extractedSample: truncate(extracted, 700),
    },
    calls,
    stages: { fetch: b.fetch, browser: b.browser, search: b.search, agent: b.agent },
  };
}
