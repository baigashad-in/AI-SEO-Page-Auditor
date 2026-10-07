// Stats from the markdown that TinyFish Fetch extracted. This is "what an AI tool reads".

import type { Heading, MarkdownStats } from "../types";
import { firstNWords, wordCount } from "../analyze/text";

export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/[*_`~]+/g, "")
    .replace(/[ \t]+/g, " ");
}

export function markdownHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  const lines = md.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (atx) {
      const text = markdownToPlain(atx[2]).trim();
      if (text) out.push({ level: atx[1].length, text });
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      if (/^\s*=+\s*$/.test(next)) out.push({ level: 1, text: markdownToPlain(line).trim() });
      else if (/^\s*-{2,}\s*$/.test(next) && !/^\s*\|/.test(line)) out.push({ level: 2, text: markdownToPlain(line).trim() });
    }
  }
  return out;
}

export function markdownStats(md: string): MarkdownStats {
  const lines = md.split(/\r?\n/);
  const headings = markdownHeadings(md);
  const listItems = lines.filter((l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l)).length;
  const tableRows = lines.filter((l) => /^\s*\|.*\|/.test(l) && !/^\s*\|?\s*:?-+:?\s*\|/.test(l)).length;
  const blocks = md.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const paragraphs = blocks.filter(
    (b) => !/^#{1,6}\s/.test(b) && !/^\s*([-*+]|\d+[.)])\s+/.test(b) && !/^\s*\|/.test(b) && wordCount(markdownToPlain(b)) >= 8,
  ).length;
  const plain = markdownToPlain(md);
  return {
    words: wordCount(plain),
    headings,
    h1Count: headings.filter((h) => h.level === 1).length,
    listItems,
    tableRows,
    paragraphs,
    firstWords: firstNWords(plain.replace(/\s+/g, " ").trim(), 150),
  };
}
