// Rules every report must satisfy, whatever the page. Each rule restates a promise the report makes
// (a strength never contradicts a finding, a summary line never claims more than its finding) in its
// own words, from the saved stage data, so a bug in one check shows up as a broken rule instead of a
// plausible-looking report. `npm run check` runs them on saved reports; see scripts/check.ts.
// Every rule here comes from a false claim found in a live demo run.

import type { AuditReport, Finding } from "../types";
import { markdownToPlain } from "../parse/markdown";
import { normForMatch } from "./text";

export interface Rule {
  id: string;
  /** The promise, in one sentence. */
  says: string;
  check: (r: AuditReport) => string[];
}

const find = (r: AuditReport, id: string): Finding | undefined => r.findings.find((f) => f.id === id);
const has = (r: AuditReport, id: string) => r.findings.some((f) => f.id === id);

/** Words a browser showed: innerText when measured, else the rendered DOM. Null without a usable render. */
function shownWords(r: AuditReport): number | null {
  const br = r.stages.browser;
  if (!br?.ok || !br.rendered || br.challenge || br.rawChallenge) return null;
  return br.renderedInnerTextWords > 0 ? br.renderedInnerTextWords : br.rendered.words;
}

/** "...2026TK, AI" from Fetch's markdown reads as "2026 TK, AI": a lowercase letter or digit before a capital is a break. */
const unglue = (s: string) => s.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2");

/** Our own wording only: text in double quotes is copied from the page and may contain anything. */
function ownText(r: AuditReport): string {
  const parts = [...r.connection, ...r.strengths, ...r.findings.flatMap((f) => [f.title, ...f.evidence, f.visibilityImpact, f.fix.summary, ...f.fix.steps])];
  return parts.map((s) => s.replace(/"[^"]*"/g, '""')).join("\n");
}

const DID_NOT_BLOCK = /\b(?:did ?n[o'’]t|does ?n[o'’]t|without|never)\s+(?:\w+\s+){0,2}?(?:block|obstruct|prevent|stop|cover)/i;
const SEVERITY = ["critical", "high", "medium", "low", "info"];
// A blocker evidence line: "<label>: <the agent's description>".
const BLOCKER_LINE = /^(other|modal|cookie wall|pop-up|login wall|paywall|CAPTCHA|age gate|region block|broken page|obstacle|block page|banner): (.*)$/;

export const RULES: Rule[] = [
  {
    id: "blocker-did-not-block",
    says: "A blocker the agent itself says did not block is never reported as one.",
    check: (r) =>
      ["answer-blockers", "answer-blocked"].flatMap((id) => (find(r, id)?.evidence.some((e) => DID_NOT_BLOCK.test(e)) ? [`"${find(r, id)!.title}" rests on a blocker that did not block`] : [])),
  },
  {
    id: "fix-matches-blocker",
    says: "A banner or pop-up never gets bot-block advice, and a block page or CAPTCHA always does.",
    check: (r) =>
      ["answer-blockers", "answer-blocked"].flatMap((id) => {
        const f = find(r, id);
        if (!f) return [];
        const blockAdvice = f.fix.steps.some((s) => /automated browsers are blocked|Verified Bots|bot manager/i.test(s));
        const names = f.title.replace(/^.*?(?:get past|\()/, "");
        const blocks = /block page|CAPTCHA|login wall|paywall|region block/.test(names);
        if (!blocks && /banner|pop-up|cookie wall/.test(names) && blockAdvice) return [`"${f.title}" gives bot-block advice for something that only covers the page`];
        if (/block page|CAPTCHA/.test(names) && !blockAdvice) return [`"${f.title}" names a block, but its fix has no bot-block advice`];
        return [];
      }),
  },
  {
    id: "server-html-vs-rendering",
    says: "\"Content is in the server HTML\" never sits next to a JavaScript or incomplete-render finding.",
    check: (r) =>
      r.strengths.some((s) => s.startsWith("Content is in the server HTML")) && (has(r, "render-js-dependent-content") || has(r, "render-incomplete"))
        ? ["the server-HTML strength contradicts a rendering finding"]
        : [],
  },
  {
    id: "server-html-vs-visible",
    says: "\"Content is in the server HTML\" is never claimed when the page showed far more text than the saved HTML.",
    check: (r) => {
      const br = r.stages.browser;
      const inner = br?.renderedInnerTextWords ?? 0;
      const saved = br?.rendered?.words ?? 0;
      return r.strengths.some((s) => s.startsWith("Content is in the server HTML")) && inner >= 1.5 * saved && inner - saved >= 40
        ? [`the server-HTML strength is claimed, but the page showed ${inner} words against ${saved} saved`]
        : [];
    },
  },
  {
    id: "blocker-label-matches-title",
    says: "Each blocker's evidence label names the kind its finding's title names, never the agent's raw \"other\" or \"modal\", and a banner is never called a pop-up.",
    check: (r) =>
      ["answer-blockers", "answer-blocked"].flatMap((id) => {
        const f = find(r, id);
        if (!f) return [];
        return f.evidence.flatMap((e) => {
          const m = e.match(BLOCKER_LINE);
          if (!m) return [];
          const [, label, desc] = m;
          const out: string[] = [];
          // 2026-10-13: Reddit's title said "a block page" while its evidence said "other: ...".
          if (label === "other" || label === "modal") out.push(`evidence is labelled "${label}" (the agent's raw label) under "${f.title}"`);
          else if (!f.title.includes(label)) out.push(`evidence says "${label}", but the title "${f.title}" does not`);
          // 2026-10-13: tinyfish.ai's "modal: A banner about Search and Fetch APIs" was called a pop-up.
          if ((label === "modal" || label === "pop-up") && /\bbanners?\b/i.test(desc) && !/pop-?ups?|modals?|overlays?|dialogs?/i.test(desc))
            out.push(`the agent describes a banner, but it is labelled "${label}"`);
          return out;
        });
      }),
  },
  {
    id: "visible-counts",
    says: "A word count or share the summary calls visible or shown matches the page's visible text, not the rendered page with its hidden text.",
    check: (r) => {
      const br = r.stages.browser;
      const inner = br?.renderedInnerTextWords ?? 0;
      if (!br?.ok || !br.raw || !br.rendered || br.challenge || inner <= 0 || inner > br.rendered.words) return [];
      const text = r.connection.join("\n");
      const share = Math.round((br.raw.words / inner) * 100);
      return [
        // 2026-10-13: Medium's summary said "a browser shows 315"; 163 words were visible.
        ...[...text.matchAll(/a browser (?:shows|sees) (\d+)/g)].filter((m) => Math.abs(Number(m[1]) - inner) > 0.2 * inner).map((m) => `"a browser shows ${m[1]}", but ${inner} words were visible`),
        ...[...text.matchAll(/(\d+) of them visible/g)].filter((m) => Number(m[1]) !== inner).map((m) => `"${m[1]} of them visible", but ${inner} words were visible`),
        // 2026-10-13: Wikipedia's "98% of the visible text" was 98% of the rendered text; against the visible text it is 110%.
        ...[...text.matchAll(/carries (\d+)% of the visible text/g)]
          .filter((m) => Math.abs(Number(m[1]) - share) > 5)
          .map((m) => `"${m[1]}% of the visible text", but the server HTML has ${share}% as many words as the visible text`),
      ];
    },
  },
  {
    id: "strength-vs-paraphrase",
    says: "The strengths never say where the agent found its answer when the summary says its quote was paraphrased.",
    check: (r) =>
      // 2026-10-13: Medium's strength said "from content visible on load" next to a paraphrased quote.
      r.connection.some((l) => l.includes("paraphrased rather than copied")) && r.strengths.some((x) => x.includes("from content visible on load"))
        ? ["a strength says the answer is visible on load, but the summary says the agent's quote was paraphrased"]
        : [],
  },
  {
    id: "answered-vs-blockers",
    says: "An \"answered\" score never sits next to a high blocker finding, and the visible-on-load strength needs \"answered\".",
    check: (r) => [
      ...(r.scores.answerability === "answered" && find(r, "answer-blockers")?.severity === "high" ? ["scored \"answered\", yet a high blocker finding"] : []),
      ...(r.strengths.some((s) => s.includes("visible on load")) && r.scores.answerability !== "answered" ? ["visible-on-load strength without an \"answered\" score"] : []),
    ],
  },
  {
    id: "thin-vs-shown",
    says: "\"Only N words are extractable\" never appears when the page has the text and Fetch lost it.",
    check: (r) => {
      if (!has(r, "extract-thin")) return [];
      const shown = shownWords(r);
      const fetched = r.stages.fetch?.stats?.words ?? 0;
      return [
        ...(has(r, "extract-content-lost") ? ["\"add more text\" next to a finding that says extraction lost the text"] : []),
        ...(shown !== null && shown >= 300 && shown >= 3 * fetched ? [`"add more text", but a browser showed ${shown} words against ${fetched} extracted`] : []),
      ];
    },
  },
  {
    id: "depth-vs-shown",
    says: "\"The top pages give AI tools Nx more text\" never appears when the page shows as many words as they give.",
    check: (r) => {
      if (!has(r, "gap-depth")) return [];
      const shown = shownWords(r);
      const words = (r.stages.search?.competitors ?? []).filter((c) => c.fetched && c.stats).map((c) => c.stats!.words).sort((a, b) => a - b);
      const median = words.length ? words[Math.floor(words.length / 2)] : null;
      return shown !== null && median !== null && shown >= median ? [`"add depth", but a browser showed ${shown} words against a median of ${median}`] : [];
    },
  },
  {
    id: "dropped-sections",
    says: "Every section listed as dropped by extraction is really missing from Fetch's text.",
    check: (r) => {
      const line = find(r, "extract-content-lost")?.evidence.find((e) => e.startsWith("Sections dropped"));
      const md = r.stages.fetch?.page?.markdown;
      if (!line || !md) return [];
      const text = ` ${normForMatch(unglue(markdownToPlain(md)))} `;
      return (line.match(/"[^"]+"/g) ?? []).filter((q) => text.includes(` ${normForMatch(unglue(q.slice(1, -1)))} `)).map((q) => `listed as dropped, but Fetch's text has ${q}`);
    },
  },
  {
    id: "summary-backed",
    says: "A summary line saying a reader never receives the answer is backed by a finding with that evidence.",
    check: (r) =>
      r.connection.some((l) => l.includes("never receive that answer")) &&
      !r.findings.some((f) => f.evidence.some((e) => e.includes("In TinyFish Fetch extraction: no") || e.includes("In raw server HTML: no")))
        ? ["the summary says a reader never receives the answer, and no finding shows it"]
        : [],
  },
  {
    id: "summary-confidence",
    says: "The summary never states as fact what a finding marks as low confidence.",
    check: (r) =>
      r.connection.some((l) => l.includes("never receive that answer")) && find(r, "answer-hidden")?.confidence === "low"
        ? ["the summary states the hidden answer as fact; its finding has low confidence"]
        : [],
  },
  {
    id: "same-page-wording",
    says: "\"Essentially the same page\" is only said when the server HTML has 90% or more of the text.",
    check: (r) =>
      // "visible" in reports saved before 2026-10-13, "rendered" since.
      [...r.connection.join("\n").matchAll(/carries (\d+)% of the (?:visible|rendered) text, so crawlers that skip JavaScript see essentially the same page/g)]
        .filter((m) => Number(m[1]) < 90)
        .map((m) => `${m[1]}% is called essentially the same page`),
  },
  {
    id: "text-artifacts",
    says: "The report's own wording has no broken punctuation, double spaces or repeated words.",
    check: (r) => {
      const t = ownText(r);
      const checks: [RegExp, string][] = [
        [/[,;:]\.\.\./, "punctuation before \"...\""],
        [/…\./, "a period after \"…\""],
        [/\S {2,}\S/, "a double space"],
        [/\b([A-Za-z]+) \1\b/i, "a repeated word"],
        [/[^.]\.\.(?!\.)/, "a double period"],
      ];
      return checks.flatMap(([re, name]) => {
        const m = t.match(re);
        return m ? [`${name}: "...${t.slice(Math.max(0, m.index! - 30), m.index! + 30).replace(/\n/g, " / ")}..."`] : [];
      });
    },
  },
  {
    id: "do-today",
    says: "Do today only names findings in the report, and findings are listed most severe first.",
    check: (r) => {
      const ids = new Set(r.findings.map((f) => f.id));
      const ranks = r.findings.map((f) => SEVERITY.indexOf(f.severity));
      return [
        ...r.doToday.filter((id) => !ids.has(id)).map((id) => `Do today names "${id}", which is not in the findings`),
        ...(ranks.some((v, i) => i > 0 && v < ranks[i - 1]) ? ["findings are not sorted by severity"] : []),
      ];
    },
  },
];

export interface RuleViolation {
  rule: string;
  message: string;
}

/** Every broken rule in one report. A rule that throws (an old report missing a field) is skipped. */
export function checkReport(r: AuditReport): RuleViolation[] {
  return RULES.flatMap((rule) => {
    try {
      return rule.check(r).map((message) => ({ rule: rule.id, message }));
    } catch {
      return [];
    }
  });
}
