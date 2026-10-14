// Short notes that say when a score rests on fewer stages than usual (a stage failed, was skipped or
// ran out of credits). The web report, the markdown export and the demo index all use these, so a
// partial score never looks like a full one.

import type { Scores, Source } from "../types";

const NAME: Record<Source, string> = { fetch: "Fetch", browser: "Browser", search: "Search", agent: "Agent" };

function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
}

export function scoreNotes(s: Scores): { readability: string | null; answerability: string | null; readabilityMeasured: boolean } {
  const miss = s.missingStages ?? [];
  const forReadability = miss.filter((x) => x === "fetch" || x === "browser").map((x) => NAME[x]);
  // No readability part was measured (the Fetch call and the Browser both failed): the score is not
  // a score. A mock run with every stage failing showed "100 (partial)" (2026-10-14).
  const measured = s.readabilityParts.length > 0;
  return {
    readability: forReadability.length ? `${measured ? "partial: " : ""}${joinNames(forReadability)} did not run` : null,
    answerability: miss.includes("agent") ? "the Agent stage gave no result" : null,
    readabilityMeasured: measured,
  };
}

/** "72/100", or "not measured" when no readability part could be measured. */
export function readabilityText(s: Scores): string {
  return s.readabilityParts.length > 0 ? `${s.readability}/100` : "not measured";
}
