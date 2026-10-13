// The sitemap note says where the sitemap came from. Reddit's robots.txt declares none, yet the note
// said "Sitemap declared in robots.txt" for the /sitemap.xml guess (2026-10-13). TinyFish is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { batch } = vi.hoisted(() => ({ batch: { robots: "", sitemapText: "" } }));

vi.mock("../lib/tinyfish", async (orig) => {
  const real = await orig<typeof import("../lib/tinyfish")>();
  return {
    ...real,
    tfFetch: vi.fn(async (body: { urls: string[] }) => {
      // The first call is the batch: page, robots.txt, llms.txt, /sitemap.xml.
      if (body.urls.length === 4) {
        const [page, robots, llms, sitemap] = body.urls;
        return {
          results: [
            { url: page, final_url: page, title: "Page", text: "A page about search engine optimization. ".repeat(40), links: [] },
            { url: robots, final_url: robots, title: null, text: batch.robots, links: [] },
            { url: sitemap, final_url: sitemap, title: "Home", text: batch.sitemapText, links: [] },
          ],
          errors: [{ url: llms, error: "page_not_found" }],
        };
      }
      // A declared sitemap fetched on its own: unreachable.
      return { results: [], errors: [{ url: body.urls[0], error: "target_unreachable" }] };
    }),
  };
});

const URL_ = "https://example.com/page";

describe("where the sitemap note says the sitemap came from", () => {
  beforeEach(() => {
    batch.robots = "User-agent: *\nDisallow: /private/";
    batch.sitemapText = "Welcome to Example. Sign in to continue. Popular posts this week.";
  });

  it("names /sitemap.xml when robots.txt declares no sitemap (Reddit)", async () => {
    const { runFetchStage } = await import("../lib/stages/fetchStage");
    const f = await runFetchStage({ url: URL_ });
    expect(f.robots.sitemaps).toEqual([]);
    expect(f.sitemap.note).toBe("Sitemap at /sitemap.xml (https://example.com/sitemap.xml) but Fetch could not read it (not a sitemap). Not checked.");
  });

  it("still says 'declared in robots.txt' when it was", async () => {
    batch.robots = "User-agent: *\nDisallow: /private/\nSitemap: https://example.com/sitemaps/index.xml";
    const { runFetchStage } = await import("../lib/stages/fetchStage");
    const f = await runFetchStage({ url: URL_ });
    expect(f.sitemap.note).toBe(
      "Sitemap declared in robots.txt (https://example.com/sitemaps/index.xml) but Fetch could not read it (target_unreachable). Not checked.",
    );
  });
});
