// When the user gives no target query, derive one from what the page says it is about.

import type { AuditInput, BrowserStageResult, FetchStageResult } from "../types";
import { rootDomain } from "../url";

const SEPARATORS = /\s+[|\u2013\u2014:\u00b7\u2022-]\s+/;

export function stripBrand(title: string): string {
  const parts = title.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return title.trim();
  // Usually "Topic | Brand". Keep the first part unless it is shorter than 3 words and another part is longer.
  const first = parts[0];
  if (first.split(/\s+/).length >= 3) return first;
  return parts.slice().sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)[0];
}

export function deriveQuery(opts: { h1?: string | null; title?: string | null }): string | null {
  const candidates = [opts.h1, opts.title].filter((x): x is string => !!x && x.trim().length > 2);
  for (const c of candidates) {
    const q = stripBrand(c)
      .replace(/["“”]/g, "")
      .split(/\s+/)
      .slice(0, 10)
      .join(" ")
      .trim();
    if (q.split(/\s+/).length >= 2) return q;
  }
  return candidates[0] ? stripBrand(candidates[0]).slice(0, 80) : null;
}

/** The user's query if given, else one derived from the page's H1 or title. */
export function resolveQuery(
  input: AuditInput,
  fetch: FetchStageResult | null,
  browser: BrowserStageResult | null,
): { query: string; derived: boolean } {
  if (input.query?.trim()) return { query: input.query.trim(), derived: false };
  const h1 = browser?.rendered?.h1[0] ?? fetch?.stats?.headings.find((h) => h.level === 1)?.text ?? null;
  const title = fetch?.page?.title ?? browser?.rendered?.title ?? null;
  const q = deriveQuery({ h1, title });
  return { query: q || rootDomain(input.url), derived: true };
}
