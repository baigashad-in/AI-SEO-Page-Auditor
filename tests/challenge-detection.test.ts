// Bot challenge pages: detected from what the reader sees on the whole page, never from scripts.
// Page shapes follow live runs on Wikipedia, Medium and Reddit.
import { describe, expect, it } from "vitest";
import { challengeReason, htmlFacts, looksLikeChallenge } from "../lib/parse/html";
import { buildFindings } from "../lib/analyze/findings";
import { buildReport } from "../lib/analyze/report";
import { pageSignals } from "../lib/analyze/query";
import { browserStage, bundle, fetchStage, LONG_TEXT, PAGE_URL } from "./helpers";

describe("bot challenge detection looks at what the reader sees, on the whole page", () => {
  it("does not flag a long article whose <head> mentions captcha in a script (Wikipedia)", () => {
    const html = `<html><head><script>var cfg={"wgConfirmEditCaptchaNeeded":true};${"/*x*/".repeat(15000)}</script>
      <title>Search engine optimization - Wikipedia</title></head><body><nav>Main menu</nav><p>${LONG_TEXT}</p></body></html>`;
    expect(html.indexOf("<body")).toBeGreaterThan(60_000);
    expect(looksLikeChallenge(html, 200)).toBe(false);
  });

  it("does not flag a short JavaScript app shell that loads Cloudflare's detection script (Medium)", () => {
    const html = `<html><head><title>Medium</title><script src="https://www.google.com/recaptcha/api.js"></script></head>
      <body><nav>Sitemap Open in app Sign up Sign in</nav><h2>The Medium Blog</h2><p>3.4M followers</p>
      <script>(function(){var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script></body></html>`;
    expect(htmlFacts(html).words).toBeLessThan(400);
    expect(looksLikeChallenge(html, 200)).toBe(false);
  });

  it("flags a challenge whose title sits after a large inline style, with entities in the text (Reddit)", () => {
    const html = `<html><head><style>${".a{color:red}".repeat(8000)}</style><title>Reddit - Prove your humanity</title></head>
      <body><h1>Prove&nbsp;your humanity</h1><p>We&#8217;re committed to safety and security. But not for bots.</p></body></html>`;
    expect(html.indexOf("<title>")).toBeGreaterThan(60_000);
    expect(looksLikeChallenge(html, 200)).toBe(true);
    expect(challengeReason(htmlFacts(html), html, 200)).toContain("prove your humanity");
  });

  it("flags challenge markup even when the text is neutral", () => {
    expect(looksLikeChallenge('<html><body><p>One moment</p><script>window._cf_chl_opt={cType:"managed"}</script></body></html>', 200)).toBe(true);
  });

  it("does not flag a short sign-in page that says it is protected by reCAPTCHA", () => {
    expect(looksLikeChallenge("<html><body><form>Email Password Sign in</form><p>This site is protected by reCAPTCHA.</p></body></html>", 200)).toBe(false);
  });

  it("uses the status code only for short responses", () => {
    expect(challengeReason({ title: null, text: "Forbidden", words: 1 }, "", 403)).toBe("HTTP 403");
    expect(challengeReason({ title: null, text: LONG_TEXT, words: 1200 }, "", 403)).toBeNull();
  });
});

describe("a challenge in the first HTML response that the browser gets past", () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>';
  const real = `<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${LONG_TEXT}</p></main></body></html>`;
  const br = browserStage(challenge, real, { rawChallenge: { title: "Just a moment...", words: 4, reason: 'the page says "just a moment"' } });
  const b = bundle({ fetch: fetchStage(`# Guide\n\n${LONG_TEXT}`), browser: br });

  it("is reported as a crawler block, not as JavaScript-only content", () => {
    const ids = buildFindings(b).map((f) => f.id);
    expect(ids).toContain("access-raw-challenge");
    expect(ids).not.toContain("render-js-dependent-content");
  });

  it("does not show the challenge's word count as the raw HTML count", () => {
    const r = buildReport(b, { url: PAGE_URL });
    expect(r.views.rawWords).toBeNull();
    expect(r.views.renderedWords).toBeGreaterThan(400);
    expect(r.connection.join(" ")).toContain("first HTML response is a bot challenge");
  });
});

describe("search inputs ignore a challenge page's title", () => {
  it("uses the Fetch title when the browser was challenged (Reddit)", () => {
    const br = browserStage("<html><head><title>Reddit - Prove your humanity</title></head><body>Prove your humanity</body></html>", undefined, {
      challenge: { title: "Reddit - Prove your humanity", words: 3 },
    });
    const f = fetchStage("text", {}, PAGE_URL, { title: "r/SEO" });
    expect(pageSignals(f, br).pageTitle).toBe("r/SEO");
  });
});
