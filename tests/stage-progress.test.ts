// Long stages print progress so the terminal never looks stuck.
import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "../lib/progress";

afterEach(() => vi.useRealTimers());

describe("stage progress", () => {
  it("prints started, a line every 15 seconds while running, and done", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const work = new Promise<number>((r) => setTimeout(() => r(42), 40_000));
    const p = track("Browser", () => work, (m) => lines.push(m), { subject: "https://example.com", summary: (n) => `${n} words` });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toBe(42);
    expect(lines[0]).toBe("Browser: started (https://example.com)");
    expect(lines.filter((l) => l.includes("still running"))).toEqual(["Browser: still running (15s)", "Browser: still running (30s)"]);
    expect(lines.at(-1)).toMatch(/^Browser: done in 40\.0s, 42 words$/);
  });

  it("prints failures and stops the heartbeat", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const p = track("Fetch", () => Promise.reject(new Error("timeout")), (m) => lines.push(m));
    await expect(p).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toEqual(["Fetch: started", "Fetch: failed after 0.0s (timeout)"]);
  });
});
