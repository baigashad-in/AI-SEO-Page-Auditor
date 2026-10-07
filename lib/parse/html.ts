// Extracts SEO and AI-readability facts from HTML. Runs on both the raw server HTML
// (what a non-JavaScript crawler gets) and the rendered DOM (what a browser user gets).

import * as cheerio from "cheerio";
import type { Heading, HtmlFacts, JsonLdSummary } from "../types";
import { wordCount } from "../analyze/text";

const TEXT_CAP = 40_000;

function clean(s: string | undefined | null): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t || null;
}

function jsonLdTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => jsonLdTypes(n, out, depth + 1));
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.add(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.add(x));
    if (obj["@graph"]) jsonLdTypes(obj["@graph"], out, depth + 1);
    for (const [k, v] of Object.entries(obj)) {
      if (k !== "@graph" && typeof v === "object") jsonLdTypes(v, out, depth + 1);
    }
  }
}

const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /__NEXT_DATA__|\/_next\/static\//],
  ["Nuxt", /__NUXT__|\/_nuxt\//],
  ["Gatsby", /___gatsby|gatsby-/],
  ["Angular", /ng-version=|ng-app/],
  ["SvelteKit", /__sveltekit|data-sveltekit/],
  ["Remix", /__remixContext/],
  ["Astro", /astro-island|data-astro-/],
  ["Vite SPA", /\/@vite\/client|type="module" crossorigin src="\/assets\/index-/],
  ["Create React App", /\/static\/js\/main\.[a-f0-9]+\.js/],
  ["WordPress", /wp-content|wp-includes/],
  ["Shopify", /cdn\.shopify\.com|Shopify\.theme/],
  ["Webflow", /webflow\.js|data-wf-page/],
  ["Wix", /static\.wixstatic\.com|wix-bolt/],
  ["Squarespace", /static1\.squarespace\.com/],
  ["Framer", /framerusercontent\.com|data-framer-/],
];

export function frameworkHints(html: string): string[] {
  const head = html.slice(0, 300_000);
  const found = FRAMEWORKS.filter(([, re]) => re.test(head)).map(([n]) => n);
  const gen = head.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (gen && !found.some((f) => gen[1].toLowerCase().includes(f.toLowerCase()))) found.push(gen[1].slice(0, 40));
  return found.slice(0, 4);
}

export function htmlFacts(html: string): HtmlFacts {
  const $ = cheerio.load(html);
  const hints = frameworkHints(html);

  const meta = (sel: string) => clean($(sel).first().attr("content"));

  // Read every <head> value now: the head is removed further down to measure body text.
  const metaDescription = meta('meta[name="description" i]');
  const robotsValues = [meta('meta[name="robots" i]'), meta('meta[name="googlebot" i]')].filter(Boolean);
  const metaRobots = robotsValues.length ? robotsValues.join(", ") : null;
  const og = {
    title: meta('meta[property="og:title"]'),
    description: meta('meta[property="og:description"]'),
    type: meta('meta[property="og:type"]'),
    image: meta('meta[property="og:image"]'),
  };

  // JSON-LD before scripts are removed
  const ld: JsonLdSummary = { blocks: 0, types: [], parseErrors: 0, sample: null };
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    ld.blocks++;
    try {
      const parsed = JSON.parse(raw);
      jsonLdTypes(parsed, types);
      if (!ld.sample) ld.sample = raw.length > 1200 ? raw.slice(0, 1200) + " …" : raw;
    } catch {
      ld.parseErrors++;
    }
  });
  ld.types = [...types].slice(0, 20);

  const scriptCount = $("script").length;
  const htmlLang = clean($("html").attr("lang"));
  const canonical = clean($('link[rel="canonical"]').first().attr("href"));
  const hreflangCount = $('link[rel="alternate"][hreflang]').length;
  const title = clean($("head title").first().text()) ?? clean($("title").first().text());

  const imgs = $("img");
  let imgMissingAlt = 0;
  imgs.each((_, el) => {
    const alt = $(el).attr("alt");
    const role = $(el).attr("role");
    const hidden = $(el).attr("aria-hidden") === "true";
    if (alt === undefined && role !== "presentation" && !hidden) imgMissingAlt++;
  });

  // Headings from the body, before removing hidden templates
  const headings: Heading[] = [];
  $("body h1, body h2, body h3, body h4").each((_, el) => {
    const text = clean($(el).text());
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text: text.slice(0, 200) });
  });

  // Visible-ish text: drop non-content nodes. noscript is kept on purpose: a non-JS crawler reads it.
  $("script, style, template, svg, iframe, link, meta, head").remove();
  const bodyText = clean($("body").text()) ?? clean($.root().text()) ?? "";

  const rootish = $("#root, #__next, #app, #__nuxt, [data-reactroot]").first();
  const emptyAppShell = rootish.length > 0 && wordCount(rootish.text()) < 20 && wordCount(bodyText) < 80;

  return {
    title,
    metaDescription,
    canonical,
    metaRobots,
    htmlLang,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings: headings.slice(0, 80),
    og,
    jsonLd: ld,
    hreflangCount,
    words: wordCount(bodyText),
    text: bodyText.slice(0, TEXT_CAP),
    imgCount: imgs.length,
    imgMissingAlt,
    hasMain: $("main, [role=main]").length > 0,
    hasArticle: $("article").length > 0,
    dataNosnippetCount: $("[data-nosnippet]").length,
    scriptCount,
    emptyAppShell,
    frameworkHints: hints,
  };
}

/** Detects bot-challenge pages (Cloudflare, Akamai, generic captcha) in a response body. */
export function looksLikeChallenge(html: string, status: number | null): boolean {
  const h = html.slice(0, 20_000).toLowerCase();
  const markers = [
    "cf-chl",
    "challenge-platform",
    "just a moment...",
    "attention required! | cloudflare",
    "access denied",
    "captcha",
    "are you a robot",
    "request unsuccessful. incapsula",
    "pardon our interruption",
    "px-captcha",
    "_incapsula_resource",
  ];
  if (status === 403 || status === 429 || status === 503) return true;
  return markers.some((m) => h.includes(m)) && wordCount(h.replace(/<[^>]+>/g, " ")) < 400;
}
