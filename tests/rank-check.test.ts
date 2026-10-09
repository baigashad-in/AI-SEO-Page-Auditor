// Rank check: keep searching page 2 when page 1 only has another URL from the same site
// (tinyfish.ai's blog post ranked, the homepage was further down). TinyFish Search is mocked.
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tinyfish", async (orig) => {
  const real = await orig<typeof import("../lib/tinyfish")>();
  return {
    ...real,
    tfSearch: vi.fn(async (p: { page?: number; includeDomains?: string[] }) => {
      if (p.includeDomains) return { results: [] };
      const r = (path: string, position: number) => ({ url: `https://${path}`, title: path, snippet: "", position, site_name: "" });
      return p.page
        ? { results: [r("www.tinyfish.ai/", 4)] }
        : { results: [r("openai.com/a", 1), r("browserbase.com/", 2), r("www.tinyfish.ai/blog/what-is-a-web-agent", 3)] };
    }),
    tfFetch: vi.fn(async () => ({ results: [], errors: [] })),
  };
});

describe("rank check keeps looking when only another URL from the site is on page 1", () => {
  it("finds the audited page on page 2 (tinyfish.ai)", async () => {
    const { runSearchStage } = await import("../lib/stages/searchStage");
    const s = await runSearchStage({ url: "https://www.tinyfish.ai/", query: "web agent api" });
    expect(s.pagesChecked).toBe(2);
    expect(s.target.position).toBe(4);
  });
});
