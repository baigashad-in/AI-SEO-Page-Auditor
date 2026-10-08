// Findings engine. Every finding is built from values observed in this audit (no generic tips),
// says which TinyFish endpoint produced the evidence, explains the effect on visibility, and gives
// a fix the site owner can apply today.

import type {
  AgentStageResult,
  BrowserStageResult,
  Finding,
  FetchStageResult,
  SearchStageResult,
  Severity,
} from "../types";
import { markdownToPlain } from "../parse/markdown";
import { contentTokens, normForMatch, phraseSet, queryCoverage, quoteAppearsIn, stem, truncate } from "./text";
import { rootDomain, sameUrl } from "../url";
import { fetchErrorHelp } from "./fetchErrors";
import { AI_BOTS } from "../parse/robots";

export interface StageBundle {
  fetch: FetchStageResult | null;
  browser: BrowserStageResult | null;
  search: SearchStageResult | null;
  agent: AgentStageResult | null;
  query: string;
  queryDerived: boolean;
  url: string;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const EFFORT_RANK = { minutes: 0, hours: 1, days: 2 } as const;

export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      EFFORT_RANK[a.fix.effort] - EFFORT_RANK[b.fix.effort] ||
      (a.confidence === "high" ? 0 : 1) - (b.confidence === "high" ? 0 : 1),
  );
}

/* Helpers */

function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : "n/a";
}

function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

// Notices, banners and site chrome that should never become a page description.
const BOILERPLATE = /redirects here|from wikipedia|please help|this article|learn how and when|cookie|subscribe|sign in|log in|javascript|skip to|all rights reserved|table of contents/i;

function fitToLength(text: string, max = 155): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]/g) || [];
  let out = "";
  for (const s of sentences) {
    const next = (out + " " + s.trim()).trim();
    if (next.length > max) break;
    out = next;
  }
  return out.length >= 60 ? out : t.slice(0, max - 3).replace(/\s+\S*$/, "") + "...";
}

/**
 * Drafts a meta description. Prefers the agent's own answer to the query (it is a direct answer,
 * which is what a good description is), else the first substantive paragraph of the extracted text.
 */
export function suggestDescription(markdown: string, h1: string | null, agentAnswer?: string | null): string {
  if (agentAnswer && agentAnswer.split(/\s+/).length >= 8) return fitToLength(agentAnswer).replace(/"/g, "'");
  const blocks = markdown.split(/\n\s*\n/).map((b) => b.trim());
  for (const b of blocks) {
    if (/^(#|\||[-*+]\s|\d+[.)]\s|>)/.test(b)) continue;
    const plain = markdownToPlain(b).replace(/\s+/g, " ").trim();
    if (plain.split(" ").length < 12 || BOILERPLATE.test(plain)) continue;
    if (h1 && plain.toLowerCase() === h1.toLowerCase()) continue;
    return fitToLength(plain).replace(/"/g, "'");
  }
  return fitToLength(markdownToPlain(markdown)).replace(/"/g, "'");
}

function ssrAdvice(hints: string[]): string {
  const h = hints.join(" ");
  if (/Next\.js/.test(h)) return "Next.js detected: render this content in a Server Component (App Router) or with getStaticProps/getServerSideProps (Pages Router). Move data fetching out of useEffect and keep 'use client' for interactive widgets only.";
  if (/Nuxt/.test(h)) return "Nuxt detected: keep ssr: true in nuxt.config and load content with useAsyncData or useFetch so it runs on the server.";
  if (/Angular/.test(h)) return "Angular detected: add server-side rendering with `ng add @angular/ssr` and prerender content routes.";
  if (/SvelteKit/.test(h)) return "SvelteKit detected: keep `export const ssr = true` and load content in +page.server.js load().";
  if (/Vite SPA|Create React App/.test(h)) return "Client-only React or Vue app detected: prerender content routes at build time, or move content pages to an SSR framework (Next.js, Remix, Astro, Nuxt).";
  if (/Gatsby/.test(h)) return "Gatsby detected: load this content at build time with a page query instead of fetching it in the browser.";
  if (/Astro/.test(h)) return "Astro detected: avoid client:only for content components so Astro renders their HTML at build time.";
  if (/WordPress/.test(h)) return "WordPress detected: content is likely injected by a page-builder widget or plugin script. Put the text in the post content or a server-rendered block.";
  if (/Wix|Squarespace|Webflow|Framer/.test(h)) return `${hints[0]} detected: text inside custom code embeds or third-party widgets renders in the browser. Move key text into native text blocks.`;
  return "Serve the main content in the initial HTML response using server-side rendering, static generation, or build-time prerendering.";
}

function articleLike(b: StageBundle): boolean {
  const r = b.browser?.rendered;
  const types = r?.jsonLd.types.join(" ") || "";
  return /Article|BlogPosting|NewsArticle/.test(types) || r?.og.type === "article" || /\/(blog|news|article|articles|posts?)\//i.test(pagePath(b.url));
}

function guessSchemaType(b: StageBundle): "Article" | "Product" | "WebSite" | "WebPage" {
  if (articleLike(b)) return "Article";
  const text = b.browser?.rendered?.text || b.fetch?.page?.markdown || "";
  if (/(add to (cart|bag)|in stock|out of stock)/i.test(text) && /[$€£]\s?\d/.test(text)) return "Product";
  if (pagePath(b.url) === "/" || pagePath(b.url) === "") return "WebSite";
  return "WebPage";
}

function jsonLdSuggestion(b: StageBundle): string {
  const type = guessSchemaType(b);
  const r = b.browser?.rendered;
  const p = b.fetch?.page;
  const url = b.browser?.finalUrl || p?.finalUrl || b.url;
  const title = r?.title || p?.title || "Page title";
  const desc = r?.metaDescription || p?.description || (p ? suggestDescription(p.markdown, r?.h1[0] ?? null, b.agent?.answer?.answer_summary) : "Short description");
  const image = r?.og.image || p?.imageLinks[0] || undefined;
  const site = rootDomain(url);
  let obj: Record<string, unknown>;
  if (type === "Article") {
    obj = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: (r?.h1[0] || title).slice(0, 110),
      description: desc,
      url,
      ...(image ? { image } : {}),
      author: { "@type": "Person", name: p?.author || "AUTHOR NAME" },
      datePublished: p?.publishedDate || "YYYY-MM-DD",
      dateModified: "YYYY-MM-DD",
      publisher: { "@type": "Organization", name: site },
    };
  } else if (type === "Product") {
    obj = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: r?.h1[0] || title,
      description: desc,
      url,
      ...(image ? { image } : {}),
      offers: { "@type": "Offer", price: "PRICE", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    };
  } else if (type === "WebSite") {
    obj = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: site, url, ...(image ? { logo: image } : {}) },
        { "@type": "WebSite", name: site, url },
      ],
    };
  } else {
    obj = { "@context": "https://schema.org", "@type": "WebPage", name: title, description: desc, url };
  }
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

/* Checks */

function accessChecks(b: StageBundle, out: Finding[]) {
  const f = b.fetch;
  const br = b.browser;

  // Fetch could not read the page at all
  if (f?.pageError) {
    const code = f.pageError.error;
    const fatal = ["bot_blocked", "login_required", "empty_content", "page_not_found", "target_http_error", "target_unreachable"].includes(code);
    const fixes: Record<string, string[]> = {
      bot_blocked: [
        "In your CDN or WAF bot settings, allow verified search and AI search crawlers: Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot, PerplexityBot.",
        "If you use Cloudflare, review the AI crawler / bot blocking settings for this zone; new zones may block AI crawlers by default.",
        "Re-run this audit to confirm Fetch receives the page instead of a challenge.",
      ],
      login_required: ["Publish a public version of this content (or a public summary page) at a crawlable URL.", "Link to it from public pages and the sitemap."],
      empty_content: ["Check that the HTML contains real text, not only images, canvas or an empty app shell.", "See the rendering findings below for what the raw HTML contains."],
      timeout: ["Reduce server response time and heavy third-party scripts.", "Check the page loads in under 5 seconds on a cold cache."],
    };
    out.push({
      id: "access-fetch-failed",
      category: "access",
      severity: fatal ? "critical" : "high",
      confidence: "high",
      title: `AI fetch tools cannot read this page (${code})`,
      evidence: [`TinyFish Fetch error: ${code}${f.pageError.status ? ` (HTTP ${f.pageError.status})` : ""}. ${fetchErrorHelp(code)}`],
      visibilityImpact: "If an AI tool cannot fetch the page, it cannot quote or cite it, no matter how well it ranks elsewhere.",
      fix: { summary: "Make the page fetchable by automated readers", steps: fixes[code] || ["Fix the server error and re-run the audit."], effort: "hours" },
      sources: ["fetch"],
    });
  }

  // robots.txt: search and AI search crawlers
  if (f) {
    const path = pagePath(f.page?.finalUrl || b.url);
    const blockedSearch = f.robots.verdicts.filter((v) => !v.allowed && (v.bot.purpose === "ai_search" || v.bot.purpose === "classic_search"));
    if (blockedSearch.length) {
      const classic = blockedSearch.some((v) => v.bot.purpose === "classic_search");
      const starGroup = blockedSearch.filter((v) => v.matchedGroup === "*").map((v) => v.bot.token);
      const ownGroup = blockedSearch.filter((v) => v.matchedGroup !== "*");
      const code = [
        ...(starGroup.length
          ? [`# Give these crawlers their own group so the "*" rules no longer apply to them`, ...starGroup.map((t) => `User-agent: ${t}`), "Allow: /", ""]
          : []),
        ...ownGroup.map((v) => `# In the existing "User-agent: ${v.matchedGroup}" group, remove or narrow:\n#   ${v.matchedRule}\n# or add this more specific rule to that group:\nAllow: ${path}`),
      ].join("\n");
      out.push({
        id: "access-robots-search-blocked",
        category: "access",
        severity: classic || blockedSearch.length >= 2 ? "critical" : "high",
        confidence: "high",
        title: `robots.txt blocks ${blockedSearch.map((v) => v.bot.token).join(", ")} from this URL`,
        evidence: blockedSearch.map((v) => `${v.bot.token} (${v.bot.operator}): blocked by "${v.matchedRule}" in group "User-agent: ${v.matchedGroup}". ${v.bot.note}`),
        visibilityImpact:
          "OpenAI states that sites opted out of OAI-SearchBot are not shown in ChatGPT search answers; Anthropic and Perplexity describe the same for their search crawlers. Blocking Googlebot or Bingbot removes the page from classic search and from AI Overviews or Copilot.",
        fix: { summary: "Allow search crawlers on this path (skip if the block is intentional)", steps: ["Edit robots.txt as shown.", "Re-run the audit; the robots table should show these bots as allowed."], code, effort: "minutes" },
        sources: ["fetch"],
      });
    }

    const blockedUser = f.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "user_fetch" && v.bot.respectsRobots);
    if (blockedUser.length) {
      out.push({
        id: "access-robots-user-blocked",
        category: "access",
        severity: "medium",
        confidence: "high",
        title: `robots.txt blocks on-demand fetches by ${blockedUser.map((v) => v.bot.token).join(", ")}`,
        evidence: blockedUser.map((v) => `${v.bot.token}: "${v.matchedRule}" (group ${v.matchedGroup})`),
        visibilityImpact: "When a user pastes this URL or asks about it, the assistant will not retrieve the page, so it answers from other sources.",
        fix: { summary: "Allow user-initiated fetchers unless you have a reason not to", steps: blockedUser.map((v) => `Remove "${v.matchedRule}" for ${v.bot.token}, or add "Allow: ${path}" to its group.`), effort: "minutes" },
        sources: ["fetch"],
      });
    }

    const blockedTraining = f.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "training");
    if (blockedTraining.length) {
      out.push({
        id: "access-robots-training-blocked",
        category: "access",
        severity: "info",
        confidence: "high",
        title: `Training crawlers blocked: ${blockedTraining.map((v) => v.bot.token).join(", ")}`,
        evidence: blockedTraining.map((v) => `${v.bot.token}: ${v.bot.note}`),
        visibilityImpact: "Per OpenAI, Anthropic and Google docs these tokens control model training, not search results. This does not reduce search or AI search visibility on its own.",
        fix: { summary: "No action needed if intentional", steps: ["Keep the block if you do not want your content used for training."], effort: "minutes" },
        sources: ["fetch"],
      });
    }
  }

  // noindex / nosnippet
  const robotsMeta = [br?.raw?.metaRobots, br?.rendered?.metaRobots, br?.headers.xRobotsTag].filter(Boolean).join(", ").toLowerCase();
  if (robotsMeta) {
    if (/noindex|(^|[\s,])none([\s,]|$)/.test(robotsMeta)) {
      out.push({
        id: "access-noindex",
        category: "access",
        severity: "critical",
        confidence: "high",
        title: "The page tells search engines not to index it",
        evidence: [
          br?.raw?.metaRobots ? `Raw HTML meta robots: "${br.raw.metaRobots}"` : "",
          br?.rendered?.metaRobots && br.rendered.metaRobots !== br.raw?.metaRobots ? `Rendered meta robots (set by JavaScript): "${br.rendered.metaRobots}"` : "",
          br?.headers.xRobotsTag ? `X-Robots-Tag header: "${br.headers.xRobotsTag}"` : "",
        ].filter(Boolean),
        visibilityImpact: "Google requires a page to be indexed to appear in Search, AI Overviews or AI Mode. A noindex page cannot be a cited source there.",
        fix: { summary: "Remove noindex if this page should be found", steps: ["Remove noindex from the meta robots tag and the X-Robots-Tag header.", "Request reindexing in Google Search Console and Bing Webmaster Tools."], effort: "minutes" },
        sources: ["browser"],
      });
    }
    const maxSnip = robotsMeta.match(/max-snippet\s*:\s*(-?\d+)/);
    if (/nosnippet/.test(robotsMeta) || (maxSnip && Number(maxSnip[1]) >= 0 && Number(maxSnip[1]) < 50)) {
      out.push({
        id: "access-nosnippet",
        category: "access",
        severity: /nosnippet/.test(robotsMeta) || Number(maxSnip?.[1]) === 0 ? "high" : "medium",
        confidence: "high",
        title: "Snippet controls limit what search and AI features can show",
        evidence: [`Robots directives found: "${robotsMeta}"`],
        visibilityImpact: "Google documents that nosnippet, max-snippet and data-nosnippet also limit how content is used in AI Overviews and AI Mode.",
        fix: { summary: "Loosen snippet limits", steps: ["Remove nosnippet, or set max-snippet:-1 to allow normal snippets."], code: `<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">`, effort: "minutes" },
        sources: ["browser"],
      });
    }
  }
  if (br?.rendered && br.rendered.dataNosnippetCount > 0) {
    out.push({
      id: "access-data-nosnippet",
      category: "access",
      severity: "low",
      confidence: "high",
      title: `${br.rendered.dataNosnippetCount} element(s) marked data-nosnippet`,
      evidence: [`data-nosnippet elements in the rendered DOM: ${br.rendered.dataNosnippetCount}`],
      visibilityImpact: "Text inside these elements is excluded from Google snippets and AI features. Fine for boilerplate, harmful if it wraps the main answer.",
      fix: { summary: "Check that data-nosnippet does not wrap your key content", steps: ["Search your templates for data-nosnippet and keep it only on boilerplate."], effort: "minutes" },
      sources: ["browser"],
    });
  }

  // Edge blocking of AI crawler user agents. Search crawlers decide visibility; training crawlers do not.
  if (br?.botProbes.length) {
    const purposeOf = (bot: string) => AI_BOTS.find((x) => x.token === bot)?.purpose ?? "ai_search";
    const bad = br.botProbes.filter((p) => p.verdict === "blocked" || p.verdict === "degraded");
    const badSearch = bad.filter((p) => purposeOf(p.bot) !== "training");
    const badTraining = bad.filter((p) => purposeOf(p.bot) === "training");
    const robotsAllows = f?.robots.verdicts.filter((v) => v.allowed).map((v) => v.bot.token) ?? [];
    const evidenceFor = (list: typeof bad) => [
      `Normal browser request: HTTP ${br.status}, ${br.raw?.words ?? 0} words in raw HTML.`,
      ...list.map((p) => `${p.bot} user-agent: HTTP ${p.status ?? "error"}, ${p.words} words${p.challenge ? ", bot challenge page" : ""} (${p.verdict}).`),
      ...list.filter((p) => robotsAllows.includes(p.bot)).map((p) => `robots.txt allows ${p.bot}, so this block happens at the server or CDN, not in robots.txt.`),
      "Caveat: requests came from a TinyFish residential IP with representative user-agent strings. Real crawlers use verified IP ranges and may be treated differently.",
    ];
    if (badSearch.length) {
      out.push({
        id: "access-edge-blocks-ai-bots",
        category: "access",
        severity: badSearch.some((p) => p.verdict === "blocked") ? "high" : "medium",
        confidence: "medium",
        title: `Server or CDN blocks AI search crawler user-agents (${badSearch.map((p) => p.bot).join(", ")})`,
        evidence: evidenceFor(badSearch),
        visibilityImpact: "These crawlers decide whether the page can appear in ChatGPT, Claude or Perplexity search answers. If the real crawler gets a challenge page, the page is not indexed there even though robots.txt allows it.",
        fix: {
          summary: "Allow verified AI search crawlers at the edge",
          steps: [
            "Check your CDN or WAF rules for user-agent based blocks (Cloudflare AI crawler blocking, Akamai bot manager, custom rules).",
            "Allow verified OAI-SearchBot, Claude-SearchBot and PerplexityBot. Verify by published IP ranges rather than user-agent alone.",
            "Check server logs for 403 responses to these user-agents.",
          ],
          effort: "hours",
        },
        sources: ["browser"],
      });
    }
    if (badTraining.length) {
      out.push({
        id: "access-edge-blocks-training-bots",
        category: "access",
        severity: "low",
        confidence: "medium",
        title: `Server or CDN blocks the training crawler user-agent (${badTraining.map((p) => p.bot).join(", ")})`,
        evidence: evidenceFor(badTraining),
        visibilityImpact:
          "This crawler collects data for model training, not search. Blocking it does not remove the page from AI search answers; the search crawlers above decide that. Many sites block it on purpose.",
        fix: { summary: "No action needed if intentional", steps: ["Keep the rule if you do not want your content used for training.", "Make sure the same rule does not also catch the search crawlers."], effort: "minutes" },
        sources: ["browser"],
      });
    }
  }

  // HTTP status and redirects
  if (br?.ok && br.status !== null && br.status >= 400 && !f?.pageError) {
    out.push({
      id: "access-http-status",
      category: "access",
      severity: "critical",
      confidence: "high",
      title: `Page returns HTTP ${br.status} to a real browser`,
      evidence: [`Browser navigation status: ${br.status}`],
      visibilityImpact: "Search engines drop pages that return error codes. AI crawlers treat them as missing.",
      fix: { summary: "Return 200 for this URL", steps: ["Fix the route or redirect it with a 301 to the right page."], effort: "hours" },
      sources: ["browser"],
    });
  }
  if (br && br.redirectChain.length >= 2) {
    out.push({
      id: "access-redirect-chain",
      category: "access",
      severity: "low",
      confidence: "high",
      title: `${br.redirectChain.length} redirects before the page loads`,
      evidence: [...br.redirectChain, `final: ${br.finalUrl}`],
      visibilityImpact: "Each hop costs crawl time and some fetchers stop following after a few redirects.",
      fix: { summary: "Link and redirect straight to the final URL", steps: [`Update internal links and the sitemap to ${br.finalUrl}.`, "Collapse the chain into a single 301."], effort: "minutes" },
      sources: ["browser"],
    });
  }

  // Canonical
  const canonical = br?.rendered?.canonical || br?.raw?.canonical || null;
  const finalUrl = br?.finalUrl || f?.page?.finalUrl || b.url;
  if (br?.ok) {
    if (canonical) {
      let abs = canonical;
      try {
        abs = new URL(canonical, finalUrl).toString();
      } catch {
        /* keep */
      }
      if (!sameUrl(abs, finalUrl)) {
        out.push({
          id: "access-canonical-elsewhere",
          category: "access",
          severity: "high",
          confidence: "high",
          title: "Canonical tag points to a different URL",
          evidence: [`This URL: ${finalUrl}`, `Canonical: ${abs}`],
          visibilityImpact: "Search engines index and credit the canonical URL, not this one. If this is not intended, this page will not rank or be cited on its own.",
          fix: { summary: "Point the canonical at this URL (unless it is a true duplicate)", steps: ["Set the canonical to the page's own preferred URL."], code: `<link rel="canonical" href="${finalUrl}">`, effort: "minutes" },
          sources: ["browser"],
        });
      }
    } else {
      out.push({
        id: "access-canonical-missing",
        category: "metadata",
        severity: "low",
        confidence: "high",
        title: "No canonical tag",
        evidence: ["No <link rel=\"canonical\"> in raw or rendered HTML."],
        visibilityImpact: "Without a canonical, URL variants (tracking parameters, trailing slashes) can split ranking signals.",
        fix: { summary: "Add a self-referencing canonical", steps: ["Add it to the <head> of the server HTML."], code: `<link rel="canonical" href="${finalUrl}">`, effort: "minutes" },
        sources: ["browser"],
      });
    }
  }

  // Sitemap and llms.txt
  if (f && f.sitemap.containsUrl === false) {
    out.push({
      id: "access-not-in-sitemap",
      category: "access",
      severity: "low",
      confidence: "medium",
      title: "Page is not listed in the sitemap",
      evidence: [`Checked: ${f.sitemap.checkedUrl}`, f.sitemap.note],
      visibilityImpact: "Sitemaps help crawlers find and re-crawl pages. Missing pages are discovered later and refreshed less often.",
      fix: { summary: "Add this URL to the sitemap", steps: [`Add <url><loc>${finalUrl}</loc><lastmod>YYYY-MM-DD</lastmod></url>.`], effort: "minutes" },
      sources: ["fetch"],
    });
  } else if (f && !f.sitemap.checkedUrl) {
    out.push({
      id: "access-no-sitemap",
      category: "access",
      severity: "low",
      confidence: "medium",
      title: "No sitemap found",
      evidence: [f.sitemap.note],
      visibilityImpact: "Crawlers rely only on links to find pages.",
      fix: { summary: "Publish a sitemap and reference it in robots.txt", steps: ["Generate /sitemap.xml.", "Add `Sitemap: https://your-site/sitemap.xml` to robots.txt."], effort: "hours" },
      sources: ["fetch"],
    });
  }
  if (f && !f.llmsTxt.found) {
    out.push({
      id: "access-llms-txt",
      category: "access",
      severity: "info",
      confidence: "medium",
      title: "No llms.txt (low priority)",
      evidence: [`${f.llmsTxt.url} not found.`],
      visibilityImpact:
        "Large studies have found no clear link between llms.txt and AI citations, and Google says it does not use it. It is cheap to add but should not come before the fixes above.",
      fix: { summary: "Optional", steps: ["Only add llms.txt after the higher-severity fixes are done."], effort: "minutes" },
      sources: ["fetch"],
    });
  }
}

function renderingChecks(b: StageBundle, out: Finding[]) {
  const br = b.browser;
  if (!br?.ok || !br.raw || !br.rendered) return;
  const raw = br.raw;
  const ren = br.rendered;
  const ratio = ren.words > 0 ? raw.words / ren.words : 1;
  const coverage = b.query ? queryCoverage(b.query, ren.text, "", []) : null;
  const rawCoverage = b.query ? queryCoverage(b.query, raw.text, "", []) : null;
  const termsOnlyAfterJs = coverage && rawCoverage ? coverage.inText.filter((t) => !rawCoverage.inText.includes(t)) : [];

  if (ren.words >= 80 && ratio < 0.7) {
    const severity: Severity = ratio < 0.3 ? "critical" : "high";
    out.push({
      id: "render-js-dependent-content",
      category: "rendering",
      severity,
      confidence: "high",
      title: `${pct(ren.words - raw.words, ren.words)} of the page text only appears after JavaScript runs`,
      evidence: [
        `Raw server HTML: ${raw.words} words. Rendered DOM: ${ren.words} words.`,
        raw.emptyAppShell ? "The raw HTML is an empty app shell (a root div with almost no text)." : "",
        br.onlyAfterJs.headings.length ? `Headings missing from raw HTML: ${br.onlyAfterJs.headings.slice(0, 5).map((h) => `"${h}"`).join(", ")}` : "",
        termsOnlyAfterJs.length ? `Query words only present after JavaScript: ${termsOnlyAfterJs.join(", ")}` : "",
        raw.frameworkHints.length ? `Detected stack: ${raw.frameworkHints.join(", ")}` : "",
      ].filter(Boolean),
      visibilityImpact:
        "GPTBot, ClaudeBot and PerplexityBot fetch HTML but do not execute JavaScript (Vercel crawler study, Dec 2024). They see the raw HTML only, so this content cannot be indexed or cited by those engines. Googlebot and Gemini do render JavaScript, but later and less reliably.",
      fix: { summary: "Put the main content in the server HTML", steps: [ssrAdvice(raw.frameworkHints), "Verify with: curl -s URL | grep \"a sentence from your page\"", "Re-run this audit; raw and rendered word counts should be close."], effort: "days" },
      sources: ["browser"],
    });
  } else if (termsOnlyAfterJs.length) {
    out.push({
      id: "render-query-terms-js-only",
      category: "rendering",
      severity: "high",
      confidence: "high",
      title: `Your target words appear only after JavaScript: ${termsOnlyAfterJs.join(", ")}`,
      evidence: [`Query: "${b.query}"`, `Present in rendered DOM, absent from raw HTML: ${termsOnlyAfterJs.join(", ")}`],
      visibilityImpact: "Non-rendering AI crawlers will not associate this page with the query.",
      fix: { summary: "Render the section that answers the query on the server", steps: [ssrAdvice(raw.frameworkHints)], effort: "hours" },
      sources: ["browser"],
    });
  }

  const js = br.onlyAfterJs;
  // A title that JavaScript rewrites (e.g. "Loading" -> "Pricing | Acme") is as bad as a missing one for non-JS crawlers.
  const titleRewritten = !!raw.title && !!ren.title && normForMatch(raw.title) !== normForMatch(ren.title);
  const lateTags = [
    js.title ? "<title>" : "",
    titleRewritten ? "<title> text" : "",
    js.h1 ? "<h1>" : "",
    js.canonical ? "canonical" : "",
    js.description ? "meta description" : "",
    js.jsonLd ? "JSON-LD structured data" : "",
  ].filter(Boolean);
  if (lateTags.length) {
    out.push({
      id: "render-tags-js-only",
      category: "rendering",
      severity: js.title || titleRewritten || js.canonical || js.h1 ? "high" : "medium",
      confidence: "high",
      title: `Key tags only exist after JavaScript: ${lateTags.join(", ")}`,
      evidence: lateTags.map((t) =>
        t === "<title> text"
          ? `<title> in raw HTML is "${truncate(raw.title, 80)}"; JavaScript changes it to "${truncate(ren.title, 80)}"`
          : `${t}: missing in raw HTML, present in rendered DOM`,
      ),
      visibilityImpact: "Crawlers that do not run JavaScript see a page without these signals, so titles, canonicals and structured data are ignored by them.",
      fix: { summary: "Emit these tags in the server HTML <head>", steps: [ssrAdvice(raw.frameworkHints), "If you use a client-side head manager (react-helmet, vue-meta), switch to the framework's server metadata API."], effort: "hours" },
      sources: ["browser"],
    });
  }
}

function extractionChecks(b: StageBundle, out: Finding[]) {
  const f = b.fetch;
  if (!f?.page || !f.stats) return;
  const s = f.stats;
  const ren = b.browser?.rendered;
  const md = f.page.markdown;
  const extractedText = markdownToPlain(md);

  // Content lost by extraction
  if (ren && ren.words >= 300) {
    const mdNorm = ` ${normForMatch(extractedText)} `;
    const lostHeadings = ren.headings
      .filter((h) => h.level <= 3)
      .map((h) => h.text)
      .filter((t) => {
        const n = normForMatch(t);
        return n.split(" ").length >= 2 && !mdNorm.includes(` ${n} `);
      });
    const ratio = s.words / ren.words;
    if (ratio < 0.35 || lostHeadings.length >= 3) {
      out.push({
        id: "extract-content-lost",
        category: "extraction",
        severity: ratio < 0.2 || lostHeadings.length >= 5 ? "high" : "medium",
        confidence: "medium",
        title: `AI extraction keeps ${pct(s.words, ren.words)} of the visible text`,
        evidence: [
          `Fetch extracted ${s.words} words; the rendered page has ${ren.words} words (navigation and footer included).`,
          lostHeadings.length ? `Sections dropped by extraction: ${lostHeadings.slice(0, 6).map((h) => `"${h}"`).join(", ")}` : "",
          `Semantic containers: <main> ${ren.hasMain ? "present" : "missing"}, <article> ${ren.hasArticle ? "present" : "missing"}.`,
        ].filter(Boolean),
        visibilityImpact: "Extractors remove what looks like boilerplate. Sections they drop are not available to the AI tool that is answering a question about your page.",
        fix: {
          summary: "Make the main content easy to identify",
          steps: [
            !ren.hasMain ? "Wrap the primary content in a single <main> element." : "Keep all primary content inside <main>.",
            !ren.hasArticle && articleLike(b) ? "Wrap the article body in <article>." : "",
            "Move key text out of carousels, sliders, tab widgets and <aside> elements, or render it as normal <section> content with <h2> headings.",
          ].filter(Boolean),
          effort: "hours",
        },
        sources: ["fetch", "browser"],
      });
    }
  }

  // Thin extracted content
  const comps = b.search?.competitors.filter((c) => c.fetched && c.stats) || [];
  const compWords = comps.map((c) => c.stats!.words).sort((a, b2) => a - b2);
  const median = compWords.length ? compWords[Math.floor(compWords.length / 2)] : null;
  if (s.words < 300) {
    out.push({
      id: "extract-thin",
      category: "extraction",
      severity: s.words < 120 ? "high" : "medium",
      confidence: "high",
      title: `Only ${s.words} words are extractable`,
      evidence: [`Fetch extracted ${s.words} words.`, median ? `Median for the top ${compWords.length} competing pages: ${median} words.` : ""].filter(Boolean),
      visibilityImpact: "AI answers quote specific passages. With little extractable text there is little for an answer engine to cite, and less evidence of relevance for ranking.",
      fix: { summary: "Add substantive, specific text that answers the query", steps: ["Add sections that answer the questions a searcher has (see the agent's missing-information list below if present).", "Use concrete facts: numbers, prices, steps, specs, dates."], effort: "hours" },
      sources: ["fetch"],
    });
  }

  // Title and description as extracted
  if (!f.page.title) {
    out.push({
      id: "meta-title-missing",
      category: "metadata",
      severity: "high",
      confidence: "high",
      title: "No title extracted",
      evidence: ["Fetch returned title: null (no og:title or <title>)."],
      visibilityImpact: "The title is the main label search engines and AI tools show for a page.",
      fix: { summary: "Add a descriptive <title> and og:title", steps: ["Put the main topic first, brand last, under 60 characters."], code: `<title>${b.query ? b.query.replace(/</g, "") : "Main topic"} | ${rootDomain(b.url)}</title>`, effort: "minutes" },
      sources: ["fetch"],
    });
  }
  if (!f.page.description) {
    const draft = suggestDescription(md, ren?.h1[0] ?? null, b.agent?.answer?.answer_summary);
    out.push({
      id: "meta-description-missing",
      category: "metadata",
      severity: "medium",
      confidence: "high",
      title: "No meta description extracted",
      evidence: ["Fetch returned description: null (no og:description or meta description)."],
      visibilityImpact: "Without a description, search engines and AI tools write their own summary from whatever text they find first.",
      fix: { summary: "Add a meta description (drafted from your page)", steps: ["Edit the draft below so it states what the page offers in under 155 characters."], code: `<meta name="description" content="${draft}">\n<meta property="og:description" content="${draft}">`, effort: "minutes" },
      sources: ["fetch"],
    });
  }
  const pageTitle = ren?.title || f.page.title;
  if (pageTitle && pageTitle.length > 65) {
    out.push({
      id: "meta-title-long",
      category: "metadata",
      severity: "low",
      confidence: "medium",
      title: `Title is ${pageTitle.length} characters and will likely be cut or rewritten`,
      evidence: [`"${truncate(pageTitle, 120)}"`],
      visibilityImpact: "Search engines often rewrite long titles, so you lose control of the label shown.",
      fix: { summary: "Shorten to about 55 to 60 characters, topic first", steps: ["Move the brand to the end and drop filler words."], effort: "minutes" },
      sources: ["browser", "fetch"],
    });
  }

  // H1 and structure
  if (ren) {
    if (ren.h1.length === 0) {
      out.push({
        id: "struct-no-h1",
        category: "extraction",
        severity: "medium",
        confidence: "high",
        title: "No <h1> on the page",
        evidence: ["Rendered DOM has 0 <h1> elements."],
        visibilityImpact: "The H1 is the strongest on-page statement of the topic for both extractors and ranking.",
        fix: { summary: "Add one <h1> that states the topic", steps: ["Use the main query words in it."], code: `<h1>${b.query || "Main topic of the page"}</h1>`, effort: "minutes" },
        sources: ["browser"],
      });
    } else if (ren.h1.length > 1) {
      out.push({
        id: "struct-multiple-h1",
        category: "extraction",
        severity: "low",
        confidence: "high",
        title: `${ren.h1.length} <h1> elements`,
        evidence: ren.h1.slice(0, 4).map((h) => `"${truncate(h, 80)}"`),
        visibilityImpact: "Several H1s blur which topic the page is about.",
        fix: { summary: "Keep one H1 and turn the rest into H2", steps: ["Usually a logo or section title is marked up as H1 by the theme."], effort: "minutes" },
        sources: ["browser"],
      });
    }
  }
  if (s.words > 600 && s.headings.length < 3) {
    out.push({
      id: "struct-wall-of-text",
      category: "extraction",
      severity: "medium",
      confidence: "medium",
      title: `${s.words} extracted words but only ${s.headings.length} heading(s)`,
      evidence: [`Extracted headings: ${s.headings.map((h) => `"${truncate(h.text, 50)}"`).join(", ") || "none"}`],
      visibilityImpact: "Retrieval systems split pages into passages, usually at headings. Clear H2/H3 sections make it easier to match one passage to one question.",
      fix: { summary: "Add descriptive H2 and H3 headings every 150 to 300 words", steps: ["Phrase some headings as the questions people search for."], effort: "hours" },
      sources: ["fetch"],
    });
  }

  // Query coverage and answer-first
  if (b.query) {
    const cov = queryCoverage(b.query, extractedText, s.firstWords, s.headings.map((h) => h.text));
    if (cov.terms.length && cov.missing.length) {
      out.push({
        id: "content-query-terms-missing",
        category: "content_gap",
        severity: cov.missing.length >= Math.ceil(cov.terms.length / 2) ? "high" : "medium",
        confidence: "high",
        title: `Extracted text never mentions: ${cov.missing.join(", ")}`,
        evidence: [`Query${b.queryDerived ? " (derived from the page)" : ""}: "${b.query}"`, `Found: ${cov.inText.join(", ") || "none"}. Missing: ${cov.missing.join(", ")}.`],
        visibilityImpact: "Retrieval for both search and AI answers starts with matching words and close variants. A page that never uses the query's words is rarely retrieved for it.",
        fix: { summary: "Use the searcher's words in the heading and first paragraph", steps: [`Work these words in naturally: ${cov.missing.join(", ")}.`], effort: "minutes" },
        sources: ["fetch"],
      });
    } else if (cov.terms.length && cov.inFirstWords.length < Math.ceil(cov.terms.length / 2)) {
      const draft = b.agent?.answer?.answer_summary;
      out.push({
        id: "content-answer-not-first",
        category: "extraction",
        severity: "medium",
        confidence: "medium",
        title: "The opening text does not address the query",
        evidence: [`First words AI tools read: "${truncate(s.firstWords, 220)}"`, `Query words in the first 150 words: ${cov.inFirstWords.join(", ") || "none"}`],
        visibilityImpact: "AI answers and featured snippets favor passages that answer directly. If the answer is buried, a competitor's direct answer gets quoted instead.",
        fix: {
          summary: "Add a 40 to 60 word direct answer right under the H1",
          steps: [`Answer "${b.query}" in plain words in the first paragraph.`, draft ? `Starting point (from the agent's answer): "${truncate(draft, 300)}"` : ""].filter(Boolean),
          effort: "minutes",
        },
        sources: ["fetch", ...(draft ? (["agent"] as const) : [])],
      });
    }
  }

  // Author and date for article-like pages
  if (articleLike(b) && (!f.page.author || !f.page.publishedDate)) {
    out.push({
      id: "meta-author-date",
      category: "metadata",
      severity: "medium",
      confidence: "medium",
      title: `Article without machine-readable ${[!f.page.author ? "author" : "", !f.page.publishedDate ? "date" : ""].filter(Boolean).join(" or ")}`,
      evidence: [`Fetch extracted author: ${f.page.author ?? "null"}, published_date: ${f.page.publishedDate ?? "null"}.`],
      visibilityImpact: "Freshness and authorship are hard for answer engines to judge without them. Undated content is easier to pass over for time-sensitive queries.",
      fix: { summary: "Add a visible byline and date, and mark them up", steps: ["Show the author name and the published or updated date near the title.", "Use <time datetime=\"YYYY-MM-DD\"> and add author, datePublished, dateModified to Article JSON-LD."], code: `<meta name="author" content="AUTHOR NAME">\n<time datetime="YYYY-MM-DD">Month D, YYYY</time>`, effort: "minutes" },
      sources: ["fetch"],
    });
  }

  if (ren && ren.imgCount >= 3 && ren.imgMissingAlt / ren.imgCount > 0.3) {
    out.push({
      id: "struct-img-alt",
      category: "extraction",
      severity: "low",
      confidence: "high",
      title: `${ren.imgMissingAlt} of ${ren.imgCount} images have no alt text`,
      evidence: [`Images without alt attribute: ${ren.imgMissingAlt}`],
      visibilityImpact: "Text tools cannot see images. Alt text is the only way information in images reaches them.",
      fix: { summary: "Describe informative images in alt text", steps: ["Use alt=\"\" for decorative images so they are skipped."], effort: "hours" },
      sources: ["browser"],
    });
  }

  const lang = ren?.htmlLang;
  if (!lang && !f.page.language) {
    out.push({
      id: "meta-lang",
      category: "metadata",
      severity: "low",
      confidence: "medium",
      title: "Page language not declared",
      evidence: ["<html> has no lang attribute and Fetch could not detect a language."],
      visibilityImpact: "Language signals help engines serve the page to the right audience.",
      fix: { summary: "Declare the language", steps: [], code: `<html lang="en">`, effort: "minutes" },
      sources: ["browser", "fetch"],
    });
  }
}

function structuredDataChecks(b: StageBundle, out: Finding[]) {
  const ren = b.browser?.rendered;
  if (!ren) return;
  if (ren.jsonLd.parseErrors > 0) {
    out.push({
      id: "schema-invalid",
      category: "structured_data",
      severity: "high",
      confidence: "high",
      title: `${ren.jsonLd.parseErrors} JSON-LD block(s) are invalid JSON`,
      evidence: [`Blocks found: ${ren.jsonLd.blocks}, failed to parse: ${ren.jsonLd.parseErrors}`],
      visibilityImpact: "Invalid JSON-LD is ignored completely, so any rich result eligibility is lost.",
      fix: { summary: "Fix the JSON syntax", steps: ["Validate with https://validator.schema.org and Google's Rich Results Test.", "Common causes: trailing commas, unescaped quotes in text, template variables left empty."], effort: "minutes" },
      sources: ["browser"],
    });
  }
  if (ren.jsonLd.blocks === 0) {
    const type = guessSchemaType(b);
    out.push({
      id: "schema-missing",
      category: "structured_data",
      severity: type === "WebPage" ? "low" : "medium", // WebPage markup earns no rich result
      confidence: "medium",
      title: `No structured data (suggested type: ${type})`,
      evidence: ["No application/ld+json blocks in raw or rendered HTML."],
      visibilityImpact:
        "Structured data states facts (type, author, dates, prices) explicitly instead of leaving them to be inferred. It enables rich results in Google; its direct effect on AI citations is not proven, so treat this as a supporting fix.",
      fix: { summary: `Add ${type} JSON-LD to the server HTML (pre-filled from this page)`, steps: ["Replace the CAPITALIZED placeholders.", "Validate at https://validator.schema.org."], code: jsonLdSuggestion(b), effort: "minutes" },
      sources: ["browser", "fetch"],
    });
  }
  if (!ren.og.title && !ren.og.description) {
    out.push({
      id: "meta-og-missing",
      category: "metadata",
      severity: "low",
      confidence: "high",
      title: "No Open Graph tags",
      evidence: ["og:title and og:description are both missing."],
      visibilityImpact: "Many fetch tools, including TinyFish Fetch, prefer og:title and og:description when summarizing a page. Chat apps also use them for link previews.",
      fix: { summary: "Add og:title, og:description, og:image", steps: [], code: `<meta property="og:title" content="${(ren.title || "").replace(/"/g, "'")}">\n<meta property="og:description" content="${(ren.metaDescription || "").replace(/"/g, "'")}">\n<meta property="og:image" content="https://.../image.jpg">`, effort: "minutes" },
      sources: ["browser"],
    });
  }
}

function visibilityChecks(b: StageBundle, out: Finding[]) {
  const s = b.search;
  if (!s || s.pagesChecked === 0) return;
  const depth = s.pagesChecked * 10;
  const topNames = s.results.slice(0, 3).map((r) => `#${r.position} ${r.siteName || rootDomain(r.url)}`).join(", ");

  if (s.target.position === null) {
    const otherUrl = s.domain.urls[0];
    out.push({
      id: "vis-not-ranking",
      category: "visibility",
      severity: otherUrl ? "medium" : b.queryDerived ? "medium" : "high",
      confidence: "medium",
      title: otherUrl ? `A different URL from your site ranks for "${s.query}" (#${otherUrl.position})` : `Not in the top ${depth} for "${s.query}"`,
      evidence: [
        `TinyFish Search (${s.location}) top results: ${topNames || "none"}.`,
        otherUrl ? `Your ranking URL: ${otherUrl.url}` : `No URL from ${rootDomain(b.url)} in the top ${depth}.`,
        b.queryDerived ? "Query was derived from the page title/H1. Re-run with the query you actually target for a sharper result." : "",
      ].filter(Boolean),
      visibilityImpact: otherUrl
        ? "Two pages on one site competing for the same query split signals. Search and AI tools pick one, and here it is not the audited page."
        : "AI search tools retrieve candidates from a search index before reading them. A page outside the top results is rarely read, so it is rarely cited.",
      fix: otherUrl
        ? { summary: "Decide which page should own this query", steps: [`Either merge the content and 301 one URL into the other, or differentiate the topics so each targets a distinct query.`, `Link from ${otherUrl.url} to the audited page with descriptive anchor text if both stay.`], effort: "hours" }
        : { summary: "Close the gap with the pages that do rank", steps: ["Fix the readability findings first (search engines cannot rank what they cannot read).", "Then cover the missing topics listed under content gaps.", "Get internal links to this page from related pages using the query words as anchor text."], effort: "days" },
      sources: ["search"],
    });
  } else {
    const pos = s.target.position;
    out.push({
      id: "vis-rank",
      category: "visibility",
      severity: pos <= 3 ? "info" : pos <= 10 ? "low" : "medium",
      confidence: "medium",
      title: `Ranks #${pos} for "${s.query}"`,
      evidence: [`TinyFish Search (${s.location}). Above you: ${s.results.filter((r) => r.position < pos).slice(0, 3).map((r) => `#${r.position} ${rootDomain(r.url)}`).join(", ") || "nobody"}.`],
      visibilityImpact: pos <= 3 ? "Top results are the ones AI search tools most often read and cite." : "AI search tools tend to read only the first few results. Moving up matters more than in classic search.",
      fix: { summary: pos <= 3 ? "Protect the position" : "Move into the top 3", steps:
          pos <= 3
            ? ["Keep the readability issues below at zero so AI tools can quote you."]
            : [
                `Open the pages above you and note what they answer that this page does not: ${s.results.filter((r) => r.position < pos).slice(0, 3).map((r) => r.url).join(", ")}`,
                "Check the content-gap and answerability findings for specific missing topics.",
              ], effort: pos <= 3 ? "minutes" : "days" },
      sources: ["search"],
    });

    const desc = b.browser?.rendered?.metaDescription || b.fetch?.page?.description;
    if (desc && s.target.serpSnippet) {
      const dTok = new Set(contentTokens(desc).map(stem));
      const sTok = contentTokens(s.target.serpSnippet).map(stem);
      const overlap = sTok.length ? sTok.filter((t) => dTok.has(t)).length / sTok.length : 0;
      if (overlap < 0.4) {
        out.push({
          id: "vis-snippet-rewritten",
          category: "visibility",
          severity: "low",
          confidence: "medium",
          title: "Search shows different text than your meta description",
          evidence: [`Your description: "${truncate(desc, 160)}"`, `Snippet shown: "${truncate(s.target.serpSnippet, 160)}"`],
          visibilityImpact: "The engine judged other text more relevant to the query. That text is also what AI tools are likely to quote.",
          fix: { summary: "Align the description with the query", steps: [`Rewrite the description to answer "${s.query}" directly, reusing the strongest phrases from the shown snippet.`], effort: "minutes" },
          sources: ["search", "browser"],
        });
      }
    }
  }

  // If the page already appeared for the target query it is clearly indexed, whatever the title probe says.
  if (s.indexProbe.query && !s.indexProbe.found && s.target.position === null) {
    out.push({
      id: "vis-index-probe",
      category: "visibility",
      severity: "high",
      confidence: "medium",
      title: "Page not found when searching its own title on its own domain",
      evidence: [
        `Searched: "${truncate(s.indexProbe.query, 100)}" restricted to ${rootDomain(b.url)}.`,
        s.indexProbe.domainUrls.length ? `Returned instead: ${s.indexProbe.domainUrls.slice(0, 3).join(", ")}` : "No pages from the domain were returned.",
        "TinyFish Search uses its own index, not Google's. Confirm in Google Search Console (URL Inspection) before acting.",
      ],
      visibilityImpact: "A page that is not in the index cannot be retrieved for any query, by classic search or by AI search tools built on top of it.",
      fix: { summary: "Get the page discovered and indexed", steps: ["Link to it from your homepage or a hub page.", "Add it to the sitemap.", "Request indexing in Google Search Console and Bing Webmaster Tools (Bing also feeds several AI assistants)."], effort: "minutes" },
      sources: ["search"],
    });
  }
}

// Words that describe page furniture or are too general to be a topic.
const GAP_IGNORE = new Set(
  (
    "frequently asked question questions faq answer answers yes no start today day days month year more less great easy " +
    "type types create creating know knowing make making made guide guides across even helpful help take taking evolve " +
    "use using used need needs want good better best many much well first work works working find look thing things " +
    "people important different example examples information learn understand include includes including based provide " +
    "provides able often every without within while however also really simple simply right overview introduction basics " +
    "next previous related read article page pages site website click step steps way ways time times part"
  )
    .split(/\s+/)
    .map(stem),
);

/**
 * Topics most competing pages cover and the target page never mentions.
 * Phrases (two adjacent words) are checked as phrases, so "search console" counts as missing even if
 * "search" and "console" appear separately. Overlapping phrases are merged ("money back" + "back
 * guarantee" become "money back guarantee"). Single words only count when a competitor uses them in a
 * heading, which keeps generic vocabulary out.
 */
export function topicGaps(
  targetText: string,
  comps: { url: string; title: string; terms: Record<string, number>; headings?: string[] }[],
  limit = 10,
): [string, { n: number; total: number }][] {
  const target = phraseSet(targetText);
  // Brand names: the domain label, plus title segments that contain it ("Google Search Central", "Digital.gov").
  // A gap term is dropped only if the whole term is part of a brand name, so "google search" is dropped
  // but "search console" is kept even though "search" appears in "Google Search Central".
  const brands = comps.flatMap((c) => {
    const label = rootDomain(c.url).split(".")[0].toLowerCase();
    const segs = c.title.split(/\s[|\u2013\u2014:-]\s/).slice(1).map((sg) => sg.toLowerCase().replace(/[^a-z0-9]/g, ""));
    return [label, ...segs.filter((n) => n.length > 1 && (n.includes(label) || label.includes(n)))];
  });
  const isBrand = (term: string) => {
    const joined = term.replace(/\s+/g, "");
    return brands.some((b) => b.includes(joined));
  };
  const headingTerms = new Map<string, number>();
  for (const c of comps) for (const t of phraseSet((c.headings || []).join("\n"))) headingTerms.set(t, (headingTerms.get(t) || 0) + 1);

  const df = new Map<string, { n: number; total: number }>();
  for (const c of comps) {
    for (const [term, count] of Object.entries(c.terms)) {
      const cur = df.get(term) || { n: 0, total: 0 };
      cur.n++;
      cur.total += count;
      df.set(term, cur);
    }
  }
  const need = Math.max(2, Math.ceil(comps.length * 0.66));
  const clean = (term: string) => !isBrand(term) && !term.split(" ").some((w) => w.length < 3 || GAP_IGNORE.has(w));
  const byStrength = (a: [string, { n: number; total: number }], c: [string, { n: number; total: number }]) =>
    (headingTerms.get(c[0]) || 0) - (headingTerms.get(a[0]) || 0) || c[1].n - a[1].n || c[1].total - a[1].total;

  const bigrams = [...df.entries()]
    .filter(([term, v]) => term.includes(" ") && v.n >= need && v.total >= 3 && clean(term) && !target.has(term))
    .sort(byStrength);
  const phrases: [string, { n: number; total: number }][] = [];
  for (const [term, v] of bigrams) {
    const [a, b] = term.split(" ");
    const hit = phrases.find(([p]) => p.endsWith(` ${a}`) || p.startsWith(`${b} `));
    if (hit) {
      if (hit[0].endsWith(` ${a}`) && !hit[0].includes(` ${b}`)) hit[0] = `${hit[0]} ${b}`;
      else if (hit[0].startsWith(`${b} `) && !hit[0].includes(`${a} `)) hit[0] = `${a} ${hit[0]}`;
      continue;
    }
    phrases.push([term, { ...v }]);
  }
  const covered = new Set(phrases.flatMap(([p]) => p.split(" ")));
  const singles = [...df.entries()]
    .filter(
      ([term, v]) =>
        !term.includes(" ") && v.n >= need && term.length >= 5 && clean(term) && !target.has(term) && !covered.has(term) && (headingTerms.get(term) || 0) >= 1,
    )
    .sort(byStrength);
  return [...phrases, ...singles].slice(0, limit);
}

function contentGapChecks(b: StageBundle, out: Finding[]) {
  const s = b.search;
  const f = b.fetch;
  if (!s || !f?.page || !f.stats) return;
  // Compare only with pages that outrank this one. A #1 page has nothing to learn from pages below it.
  const pos = s.target.position;
  const comps = s.competitors.filter((c) => c.fetched && c.stats && (pos === null || c.position < pos));
  if (comps.length < 2) return;
  const whom = pos === null ? "top-ranking pages" : "pages ranking above this one";

  const gaps = topicGaps(
    markdownToPlain(f.page.markdown) + "\n" + f.stats.headings.map((h) => h.text).join("\n"),
    comps.map((c) => ({ url: c.url, title: c.title, terms: c.terms, headings: c.stats?.headings.map((h) => h.text) })),
  );
  const ranksTop3 = s.target.position !== null && s.target.position <= 3;

  if (gaps.length >= 3) {
    out.push({
      id: "gap-terms",
      category: "content_gap",
      severity: ranksTop3 ? "low" : "medium",
      confidence: "medium",
      title: `${gaps.length} topics the ${whom} cover and this page does not`,
      evidence: [
        `Compared with: ${comps.map((c) => `#${c.position} ${rootDomain(c.url)}`).join(", ")}`,
        `Missing from your extracted text: ${gaps.map(([t, v]) => `${t} (${v.n}/${comps.length})`).join(", ")}`,
      ],
      visibilityImpact: "These are the words and sub-topics that searchers' queries and AI answers draw on. Pages that cover them match more question variants.",
      fix: { summary: "Add sections that cover the strongest gaps", steps: ["Group related terms into one or two new H2 sections.", "Only add what is true and useful for your offer; do not keyword-stuff."], effort: "hours" },
      sources: ["search", "fetch"],
    });
  }

  const words = comps.map((c) => c.stats!.words).sort((a, b2) => a - b2);
  const median = words[Math.floor(words.length / 2)];
  if (median >= 2 * Math.max(f.stats.words, 1) && median > 400) {
    out.push({
      id: "gap-depth",
      category: "content_gap",
      severity: "medium",
      confidence: "medium",
      title: `The ${whom} give AI tools ${Math.round(median / Math.max(f.stats.words, 1))}x more text`,
      evidence: comps.map((c) => `#${c.position} ${rootDomain(c.url)}: ${c.stats!.words} words, ${c.stats!.headings.length} headings, ${c.stats!.listItems} list items, ${c.stats!.tableRows} table rows`).concat([`You: ${f.stats.words} words, ${f.stats.headings.length} headings`]),
      visibilityImpact: "Length is not a ranking factor by itself, but depth usually means more answered sub-questions and more quotable passages.",
      fix: { summary: "Add depth where it answers real questions", steps: ["Use the agent's missing-information list and the topic gaps as the outline for new sections."], effort: "hours" },
      sources: ["search", "fetch"],
    });
  }

  const compStructured = comps.filter((c) => c.stats!.tableRows >= 3 || c.stats!.listItems >= 8).length;
  if (compStructured >= 2 && f.stats.tableRows < 3 && f.stats.listItems < 4) {
    out.push({
      id: "gap-structure",
      category: "content_gap",
      severity: "low",
      confidence: "medium",
      title: `The ${whom} use lists and tables; this page is mostly prose`,
      evidence: comps.map((c) => `#${c.position} ${rootDomain(c.url)}: ${c.stats!.listItems} list items, ${c.stats!.tableRows} table rows`).concat([`You: ${f.stats.listItems} list items, ${f.stats.tableRows} table rows`]),
      visibilityImpact: "Lists and tables extract cleanly and are easy to quote as steps, comparisons and specs.",
      fix: { summary: "Turn steps, specs and comparisons into real HTML lists and tables", steps: ["Use <ol>/<ul> and <table>, not styled <div>s."], effort: "hours" },
      sources: ["search", "fetch"],
    });
  }
}

const BLOCKER_PHRASE: Record<string, string> = {
  cookie_wall: "a cookie wall",
  modal: "a pop-up",
  login_wall: "a login wall",
  paywall: "a paywall",
  captcha: "a CAPTCHA",
  age_gate: "an age gate",
  region_block: "a region block",
  broken_page: "a broken page",
  other: "an obstacle",
};

function answerabilityChecks(b: StageBundle, out: Finding[]) {
  const a = b.agent?.answer;
  if (!a) return;
  const extracted = b.fetch?.page ? markdownToPlain(b.fetch.page.markdown) : null;
  const rawText = b.browser?.raw?.text ?? null;
  const inFetch = a.evidence_quote && extracted !== null ? quoteAppearsIn(a.evidence_quote, extracted) : null;
  const inRaw = a.evidence_quote && rawText !== null ? quoteAppearsIn(a.evidence_quote, rawText) : null;

  if (!a.answer_found) {
    out.push({
      id: "answer-not-found",
      category: "answerability",
      severity: b.queryDerived ? "medium" : "high",
      confidence: "medium",
      title: `An AI agent could not answer "${b.query}" from this page`,
      evidence: [
        `Agent's view of the page: ${a.page_purpose || "n/a"}`,
        a.missing_information.length ? `What it says is missing: ${a.missing_information.join("; ")}` : "",
        ...a.blockers.map((x) => `Blocker: ${x.type}, ${x.description}`),
      ].filter(Boolean),
      visibilityImpact: "Answer engines cite pages that answer the question. If an agent reading the live page cannot find the answer, it will cite a page that has one.",
      fix: { summary: "Add the missing answer", steps: a.missing_information.length ? a.missing_information.map((m) => `Add: ${m}`) : [`Add a section that directly answers "${b.query}".`], effort: "hours" },
      sources: ["agent"],
    });
  } else {
    const hidden = a.answer_location === "after_interaction";
    if (a.evidence_quote && (inFetch === false || inRaw === false || hidden)) {
      let severity: Severity = "low";
      let title = "";
      if (inFetch === false && inRaw === false) {
        severity = "high";
        title = "The answer exists, but neither AI fetch tools nor non-JS crawlers can see it";
      } else if (inRaw === false) {
        severity = "medium";
        title = "The answer is only in the page after JavaScript runs";
      } else if (inFetch === false) {
        severity = "medium";
        title = "The answer is in the HTML, but AI extraction drops it";
      } else {
        severity = "low";
        title = "The answer is readable by crawlers but hidden from people behind a click";
      }
      out.push({
        id: "answer-hidden",
        category: "answerability",
        severity,
        confidence: "medium",
        title,
        evidence: [
          `Agent's evidence: "${truncate(a.evidence_quote, 240)}"`,
          `Where the agent found it: ${a.answer_location.replace(/_/g, " ")}${a.interactions_needed.length ? ` (${a.interactions_needed.join(" > ")})` : ""}`,
          `In TinyFish Fetch extraction: ${inFetch === null ? "not checked" : inFetch ? "yes" : "no"}. In raw server HTML: ${inRaw === null ? "not checked" : inRaw ? "yes" : "no"}.`,
        ],
        visibilityImpact: "Only a browsing agent that clicks can reach this answer. Search crawlers and fetch tools quote what is in the HTML they receive.",
        fix: {
          summary: "Show the answer by default in the server HTML",
          steps: [
            hidden ? "Render tab or accordion content in the HTML (collapsed with CSS or <details>), not loaded on click." : "",
            inRaw === false ? ssrAdvice(b.browser?.raw?.frameworkHints || []) : "",
            inFetch === false ? "Put the answer in a normal <p> inside <main>, near the top, not in a widget, image or carousel." : "",
          ].filter(Boolean),
          code: hidden ? `<details open>\n  <summary>${truncate(b.query, 80)}</summary>\n  <p>${truncate(a.evidence_quote, 200)}</p>\n</details>` : undefined,
          effort: inRaw === false ? "days" : "hours",
        },
        sources: ["agent", ...(inFetch !== null ? (["fetch"] as const) : []), ...(inRaw !== null ? (["browser"] as const) : [])],
      });
    }
  }

  const serious = a.blockers.filter((x) => ["login_wall", "paywall", "captcha", "region_block", "broken_page"].includes(x.type));
  const covering = a.blockers.filter((x) => ["cookie_wall", "modal", "age_gate", "other"].includes(x.type));
  if (serious.length || covering.length) {
    out.push({
      id: "answer-blockers",
      category: "answerability",
      severity: serious.length ? "high" : "medium",
      confidence: "medium",
      title: `The agent had to get past ${[...new Set([...serious, ...covering].map((x) => BLOCKER_PHRASE[x.type] || "an obstacle"))].join(", ")}`,
      evidence: [...serious, ...covering].map((x) => `${x.type}: ${x.description}`),
      visibilityImpact: "Browsing agents (ChatGPT agent, Claude in Chrome and similar) have to get past these to read the page. Each one is a chance to give up and use another source.",
      fix: {
        summary: "Do not cover content with overlays",
        steps: [
          covering.length ? "Use a cookie banner that sits at the bottom of the screen and does not block reading or replace content in the HTML." : "",
          covering.some((x) => x.type === "modal") ? "Delay newsletter or promo pop-ups, or remove them on content pages." : "",
          serious.length ? "Keep a crawlable public summary of gated content above the wall." : "",
        ].filter(Boolean),
        effort: "hours",
      },
      sources: ["agent"],
    });
  }
}

function stageNotes(b: StageBundle, out: Finding[]) {
  const missing: string[] = [];
  if (b.browser && !b.browser.ok) missing.push(`Browser stage failed: ${b.browser.error}`);
  if (b.agent && !b.agent.ok) missing.push(`Agent stage did not complete: ${b.agent.error || b.agent.status}`);
  if (b.search && b.search.pagesChecked === 0) missing.push("Search stage returned no results.");
  if (!b.browser) missing.push("Browser stage skipped.");
  if (!b.agent) missing.push("Agent stage skipped.");
  if (missing.length) {
    out.push({
      id: "audit-coverage",
      category: "access",
      severity: "info",
      confidence: "high",
      title: "Some checks did not run",
      evidence: missing,
      visibilityImpact: "Findings that depend on these stages are missing from this report, so scores are based on fewer signals.",
      fix: { summary: "Re-run with all stages", steps: ["Check credits and that the Browser API is enabled on your TinyFish account."], effort: "minutes" },
      sources: [],
    });
  }
}

export function buildFindings(b: StageBundle): Finding[] {
  const out: Finding[] = [];
  accessChecks(b, out);
  renderingChecks(b, out);
  extractionChecks(b, out);
  structuredDataChecks(b, out);
  visibilityChecks(b, out);
  contentGapChecks(b, out);
  answerabilityChecks(b, out);
  stageNotes(b, out);
  // De-duplicate by id (first wins) and sort.
  const seen = new Set<string>();
  return sortFindings(out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))));
}

export function buildStrengths(b: StageBundle): string[] {
  const s: string[] = [];
  const br = b.browser;
  const f = b.fetch;
  if (f && f.robots.verdicts.filter((v) => v.bot.purpose === "ai_search").every((v) => v.allowed)) s.push("robots.txt allows every AI search crawler checked (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Applebot).");
  if (br?.raw && br.rendered && br.rendered.words > 0 && br.raw.words / br.rendered.words >= 0.9) s.push(`Content is in the server HTML (${br.raw.words} of ${br.rendered.words} words), so non-JavaScript AI crawlers can read it.`);
  const searchProbes = br?.botProbes.filter((p) => AI_BOTS.find((x) => x.token === p.bot)?.purpose !== "training") ?? [];
  if (searchProbes.length && searchProbes.every((p) => p.verdict === "ok"))
    s.push(`Requests with AI search crawler user-agents (${searchProbes.map((p) => p.bot).join(", ")}) got the same page as a normal browser.`);
  if (f?.stats && f.stats.words >= 600 && f.stats.headings.length >= 3) s.push(`Extraction is substantial and structured: ${f.stats.words} words under ${f.stats.headings.length} headings.`);
  if (br?.rendered && br.rendered.jsonLd.blocks > 0 && br.rendered.jsonLd.parseErrors === 0) s.push(`Valid structured data: ${br.rendered.jsonLd.types.join(", ") || "JSON-LD present"}.`);
  if (b.search?.target.position && b.search.target.position <= 3) s.push(`Ranks #${b.search.target.position} for "${b.search.query}".`);
  if (b.agent?.answer?.answer_found && b.agent.answer.answer_location === "visible_on_load") s.push("An AI agent answered the query from content visible on load.");
  return s;
}
