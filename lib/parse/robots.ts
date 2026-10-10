// robots.txt parser (RFC 9309 matching: most specific user-agent group, longest path match, Allow wins ties)
// plus the list of crawlers that decide whether a page can show up in AI answers.

import type { BotInfo, RobotsVerdict } from "../types";

// Sources for purposes and robots behavior:
// OpenAI: https://developers.openai.com/api/docs/bots
// Anthropic: https://support.claude.com/en/articles/8896518
// Perplexity: https://docs.perplexity.ai/docs/resources/perplexity-crawlers
// Google AI features: https://developers.google.com/search/docs/appearance/ai-features
export const AI_BOTS: BotInfo[] = [
  { token: "Googlebot", operator: "Google", purpose: "classic_search", respectsRobots: true, note: "Google Search, including AI Overviews and AI Mode." },
  { token: "Bingbot", operator: "Microsoft", purpose: "classic_search", respectsRobots: true, note: "Bing Search and Copilot answers." },
  { token: "OAI-SearchBot", operator: "OpenAI", purpose: "ai_search", respectsRobots: true, note: "Decides if the page can appear in ChatGPT search answers." },
  { token: "Claude-SearchBot", operator: "Anthropic", purpose: "ai_search", respectsRobots: true, note: "Indexes pages for Claude search results." },
  { token: "PerplexityBot", operator: "Perplexity", purpose: "ai_search", respectsRobots: true, note: "Decides if the page can be surfaced and linked in Perplexity." },
  { token: "Applebot", operator: "Apple", purpose: "ai_search", respectsRobots: true, note: "Siri and Spotlight suggestions." },
  { token: "ChatGPT-User", operator: "OpenAI", purpose: "user_fetch", respectsRobots: false, note: "Fetches when a ChatGPT user asks. OpenAI says robots.txt may not apply." },
  { token: "Claude-User", operator: "Anthropic", purpose: "user_fetch", respectsRobots: true, note: "Fetches when a Claude user asks. Blocking it stops Claude retrieving the page." },
  { token: "Perplexity-User", operator: "Perplexity", purpose: "user_fetch", respectsRobots: false, note: "Fetches when a Perplexity user asks. Generally ignores robots.txt." },
  { token: "GPTBot", operator: "OpenAI", purpose: "training", respectsRobots: true, note: "Model training only. Blocking it does not remove you from ChatGPT search." },
  { token: "ClaudeBot", operator: "Anthropic", purpose: "training", respectsRobots: true, note: "Model training only." },
  { token: "Google-Extended", operator: "Google", purpose: "training", respectsRobots: true, note: "Gemini training and grounding outside Search. Does not affect Google Search or AI Overviews." },
  { token: "Applebot-Extended", operator: "Apple", purpose: "training", respectsRobots: true, note: "Apple model training only." },
  { token: "CCBot", operator: "Common Crawl", purpose: "training", respectsRobots: true, note: "Open web corpus used by many model trainers." },
];

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string; raw: string }[];
}

export interface ParsedRobots {
  groups: Group[];
  sitemaps: string[];
  validLines: number;
  reflowed: boolean; // line breaks were missing and were restored before parsing
}

// Standard fields plus the non-standard ones seen in real files (License is the RSL licensing line,
// Content-Signal is Cloudflare's, Content-Usage is the IETF AI preferences draft). Each one starts a
// new line when line breaks are restored, so it is never glued onto the URL or path before it.
const FIELDS = "user-agent|allow|disallow|sitemap|crawl-delay|host|clean-param|content-signal|content-usage|license|request-rate|visit-time|noindex";
const DIRECTIVE_AHEAD = new RegExp(`\\s+(?=(?:${FIELDS})\\s*:)`, "gi");
const DIRECTIVE = new RegExp(`(?:^|\\s)(?:${FIELDS})\\s*:`, "gi");

/** Paths, product tokens and sitemap URLs never contain spaces, so anything after one is not part of the value. */
const firstToken = (v: string) => v.split(/\s+/)[0] ?? "";

/**
 * Restores line breaks when robots.txt arrives with its lines joined, as a markdown conversion can do:
 * "# Welcome ... User-agent: * Disallow: /" would otherwise read as one long comment, or as a
 * user-agent called "* disallow: /". Only applies when there are more directives than lines and at
 * least one line holds two of them, so a normal file (one directive per line) is never touched.
 */
export function reflowRobots(txt: string): { text: string; reflowed: boolean } {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const count = (l: string) => (l.match(DIRECTIVE) || []).length;
  const total = lines.reduce((n, l) => n + count(l), 0);
  if (!(total > lines.length && lines.some((l) => count(l) >= 2))) return { text: txt, reflowed: false };
  const text = txt.replace(/\s+(?=#)/g, "\n").replace(DIRECTIVE_AHEAD, "\n");
  return { text, reflowed: true };
}

export function parseRobots(input: string): ParsedRobots {
  const { text: txt, reflowed } = reflowRobots(input);
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  let validLines = 0;
  for (const rawLine of txt.split(/\r?\n/)) {
    // Markdown conversion can add list bullets or quote markers in front of lines.
    const line = rawLine.replace(/#.*$/, "").replace(/^\s*(?:[-+]\s+|\d+[.)]\s+|>\s*)/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = firstToken(m[2].trim());
    if (field === "user-agent") {
      validLines++;
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === "sitemap") {
      validLines++;
      if (/^https?:\/\/\S+$/i.test(value)) sitemaps.push(value);
      continue;
    }
    if ((field === "allow" || field === "disallow") && current) {
      validLines++;
      current.rules.push({ allow: field === "allow", path: value, raw: `${field === "allow" ? "Allow" : "Disallow"}: ${value}` });
    }
    lastWasAgent = false;
  }
  return { groups, sitemaps, validLines, reflowed };
}

function patternToRegex(path: string): RegExp {
  let p = path;
  const anchored = p.endsWith("$");
  if (anchored) p = p.slice(0, -1);
  const esc = p.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + (anchored ? "$" : ""));
}

/** Picks the group for a bot: exact product-token match first, else "*". Groups naming the same agent are merged. */
function groupsFor(parsed: ParsedRobots, token: string): { rules: Group["rules"]; name: string | null } {
  const t = token.toLowerCase();
  const specific = parsed.groups.filter((g) => g.agents.some((a) => a === t));
  if (specific.length) return { rules: specific.flatMap((g) => g.rules), name: token };
  const star = parsed.groups.filter((g) => g.agents.includes("*"));
  if (star.length) return { rules: star.flatMap((g) => g.rules), name: "*" };
  return { rules: [], name: null };
}

export function isAllowed(parsed: ParsedRobots, token: string, pathWithQuery: string): { allowed: boolean; group: string | null; rule: string | null } {
  const { rules, name } = groupsFor(parsed, token);
  let best: { allow: boolean; len: number; raw: string } | null = null;
  for (const r of rules) {
    if (r.path === "") continue; // "Disallow:" with empty value allows everything
    if (!patternToRegex(r.path).test(pathWithQuery)) continue;
    const len = r.path.replace(/\*|\$$/g, "").length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) {
      best = { allow: r.allow, len, raw: r.raw };
    }
  }
  if (!best) return { allowed: true, group: name, rule: null };
  return { allowed: best.allow, group: name, rule: best.raw };
}

export function robotsVerdicts(
  robotsTxt: string | null,
  pageUrl: string,
): { verdicts: RobotsVerdict[]; sitemaps: string[]; validLines: number; reflowed: boolean } {
  const u = new URL(pageUrl);
  const path = (u.pathname || "/") + (u.search || "");
  if (robotsTxt === null) {
    return {
      verdicts: AI_BOTS.map((bot) => ({ bot, allowed: true, matchedGroup: null, matchedRule: null })),
      sitemaps: [],
      validLines: 0,
      reflowed: false,
    };
  }
  const parsed = parseRobots(robotsTxt);
  return {
    verdicts: AI_BOTS.map((bot) => {
      const r = isAllowed(parsed, bot.token, path);
      return { bot, allowed: r.allowed, matchedGroup: r.group, matchedRule: r.rule };
    }),
    sitemaps: parsed.sitemaps,
    validLines: parsed.validLines,
    reflowed: parsed.reflowed,
  };
}

/** Heuristic for "the server answered /robots.txt with an HTML page" (soft 404). */
export function looksLikeRobots(txt: string): boolean {
  return parseRobots(txt).validLines > 0;
}
