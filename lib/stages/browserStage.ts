// Stage 2: TinyFish Browser. What does the server send BEFORE JavaScript runs, and what exists AFTER?
// GPTBot, ClaudeBot and PerplexityBot do not execute JavaScript (Vercel, Dec 2024), so content that
// only exists after rendering is invisible to them. Fetch cannot answer this because it returns
// cleaned, already-rendered content, so this stage drives a real remote Chromium over CDP.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { AuditInput, BotProbe, BrowserStageResult, CallLog, HtmlFacts } from "../types";
import { tfCreateBrowserSession, tfDeleteBrowserSession, TinyFishError } from "../tinyfish";
import { htmlFacts, looksLikeChallenge } from "../parse/html";
import { normForMatch, wordCount } from "../analyze/text";
import { parseInputUrl } from "../url";

// Representative user-agent strings from each operator's public docs. Real crawlers also come from
// verified IP ranges, so a block here is strong evidence and a pass is weak evidence.
export const PROBE_BOTS = [
  { bot: "OAI-SearchBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot" },
  { bot: "ClaudeBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { bot: "PerplexityBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
];

function onlyAfterJs(raw: HtmlFacts, rendered: HtmlFacts) {
  const rawText = ` ${normForMatch(raw.text)} `;
  const rawHeads = new Set(raw.headings.map((h) => normForMatch(h.text)));
  const headings = rendered.headings
    .map((h) => h.text)
    .filter((t) => {
      const n = normForMatch(t);
      return n.length > 2 && !rawHeads.has(n) && !rawText.includes(` ${n} `);
    })
    .slice(0, 15);
  return {
    headings,
    title: !raw.title && !!rendered.title,
    description: !raw.metaDescription && !!rendered.metaDescription,
    canonical: !raw.canonical && !!rendered.canonical,
    h1: raw.h1.length === 0 && rendered.h1.length > 0,
    jsonLd: raw.jsonLd.blocks === 0 && rendered.jsonLd.blocks > 0,
  };
}

async function probe(browser: Browser, url: string, bot: { bot: string; ua: string }, baselineWords: number, baselineStatus: number | null): Promise<BotProbe> {
  let page: Page | null = null;
  let ownContext: BrowserContext | null = null;
  try {
    try {
      ownContext = await browser.newContext({ userAgent: bot.ua, javaScriptEnabled: false });
      page = await ownContext.newPage();
    } catch {
      // Some remote browsers only expose the default context. Fall back to it and set the UA per request.
      page = await browser.contexts()[0].newPage();
    }
    // Only the HTML document matters here. Skipping subresources keeps the probe fast and cheap.
    // The user-agent header is also set explicitly in case the context-level override is not applied.
    await page.route("**/*", (r) =>
      r.request().resourceType() === "document"
        ? r.continue({ headers: { ...r.request().headers(), "user-agent": bot.ua } })
        : r.abort(),
    );
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const status = resp?.status() ?? null;
    const body = resp ? await resp.text().catch(() => "") : "";
    const words = wordCount(htmlFacts(body).text);
    const challenge = looksLikeChallenge(body, status);
    let verdict: BotProbe["verdict"] = "ok";
    const baselineOk = baselineStatus !== null && baselineStatus < 400;
    if (baselineOk && (challenge || (status !== null && status >= 400))) verdict = "blocked";
    else if (baselineWords >= 100 && words < baselineWords * 0.5) verdict = "degraded";
    if (ownContext) await ownContext.close().catch(() => {});
    else await page.close().catch(() => {});
    return { bot: bot.bot, userAgent: bot.ua, status, words, challenge, verdict };
  } catch (err) {
    if (ownContext) await ownContext.close().catch(() => {});
    else if (page) await page.close().catch(() => {});
    return { bot: bot.bot, userAgent: bot.ua, status: null, words: 0, challenge: false, verdict: "error", error: (err as Error).message.slice(0, 200) };
  }
}

export async function runBrowserStage(input: AuditInput): Promise<BrowserStageResult> {
  const pageUrl = parseInputUrl(input.url).toString();
  const calls: CallLog[] = [];
  const out: BrowserStageResult = {
    ok: false,
    requestedUrl: pageUrl,
    finalUrl: null,
    status: null,
    redirectChain: [],
    headers: { xRobotsTag: null, contentType: null },
    raw: null,
    rendered: null,
    renderedInnerTextWords: 0,
    onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
    botProbes: [],
    screenshot: null,
    calls,
  };

  const t0 = Date.now();
  let session;
  try {
    session = await tfCreateBrowserSession({ timeout_seconds: 180 });
  } catch (err) {
    const e = err as TinyFishError;
    calls.push({ endpoint: "browser", purpose: "Create remote browser session", ms: Date.now() - t0, ok: false, detail: e.message });
    out.error =
      e.status === 404
        ? "Browser API is not enabled for this TinyFish account (404). Ask TinyFish support to enable it."
        : e.status === 402
          ? "Not enough TinyFish credits for a Browser session (402)."
          : e.message;
    return out;
  }
  calls.push({ endpoint: "browser", purpose: "Create remote browser session", ms: Date.now() - t0, ok: true });

  let browser: Browser | null = null;
  const t1 = Date.now();
  try {
    browser = await chromium.connectOverCDP(session.cdp_url, { timeout: 30_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

    const resp = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const rawHtml = resp ? await resp.text().catch(() => "") : "";
    out.status = resp?.status() ?? null;
    const headers = resp ? await resp.allHeaders().catch(() => ({}) as Record<string, string>) : {};
    out.headers = { xRobotsTag: headers["x-robots-tag"] ?? null, contentType: headers["content-type"] ?? null };
    const chain: string[] = [];
    let prev = resp?.request().redirectedFrom() ?? null;
    while (prev) {
      chain.unshift(prev.url());
      prev = prev.redirectedFrom();
    }
    out.redirectChain = chain;

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Scroll once to trigger lazy-loaded sections, then return to the top for the screenshot.
    await page
      .evaluate(async () => {
        window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        await new Promise((r) => setTimeout(r, 1200));
        window.scrollTo(0, 0);
      })
      .catch(() => {});
    out.screenshot = await page
      .screenshot({ type: "jpeg", quality: 55 })
      .then((b) => `data:image/jpeg;base64,${b.toString("base64")}`)
      .catch(() => null);
    const renderedHtml = await page.content();
    out.renderedInnerTextWords = await page
      .evaluate(() => (document.body ? document.body.innerText : ""))
      .then((t) => wordCount(t))
      .catch(() => 0);
    out.finalUrl = page.url();
    await page.close().catch(() => {});

    out.raw = htmlFacts(rawHtml);
    out.rendered = htmlFacts(renderedHtml);
    out.onlyAfterJs = onlyAfterJs(out.raw, out.rendered);
    calls.push({
      endpoint: "browser",
      purpose: "Load page over CDP: capture raw server HTML, rendered DOM, headers, screenshot",
      ms: Date.now() - t1,
      ok: true,
      detail: `status ${out.status}, raw ${out.raw.words} words, rendered ${out.rendered.words} words`,
    });

    const t2 = Date.now();
    out.botProbes = await Promise.all(PROBE_BOTS.map((b) => probe(browser!, out.finalUrl || pageUrl, b, out.raw!.words, out.status)));
    calls.push({
      endpoint: "browser",
      purpose: `Request the page as ${PROBE_BOTS.map((b) => b.bot).join(", ")} (JavaScript off) to detect edge blocking`,
      ms: Date.now() - t2,
      ok: true,
      detail: out.botProbes.map((p) => `${p.bot}: ${p.verdict}`).join(", "),
    });
    out.ok = true;
  } catch (err) {
    out.error = (err as Error).message.slice(0, 300);
    calls.push({ endpoint: "browser", purpose: "Load page over CDP", ms: Date.now() - t1, ok: false, detail: out.error });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await tfDeleteBrowserSession(session.session_id);
  }
  return out;
}
