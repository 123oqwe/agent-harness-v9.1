/** AH-RESEARCH-VERTICAL-001: sources -> evidence -> report with conflict identification. */
// @ts-nocheck

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { searchFiles } from '../tools/search-files.js';
import { readFile } from '../tools/read-file.js';

export interface ResearchVerticalInput { sources: string[]; query: string }
export interface ResearchVerticalOutput {
  evidence: { source: string; excerpt: string }[];
  conflicts: string[];
  report: string;
  citations: string[];
}

export async function runResearchVertical(vfs: VirtualFilesystem, input: ResearchVerticalInput): Promise<ResearchVerticalOutput> {
  const evidence: { source: string; excerpt: string }[] = [];
  for (const src of input.sources) {
    try {
      const r = await readFile(vfs, { path: src });
      const idx = r.content.toLowerCase().indexOf(input.query.toLowerCase());
      if (idx >= 0) evidence.push({ source: src, excerpt: r.content.slice(Math.max(0, idx - 50), idx + 100) });
    } catch { /* skip unreadable */ }
  }
  // detect conflicts: same query, different excerpts
  const excerpts = evidence.map(e => e.excerpt);
  const unique = new Set(excerpts.map(e => e.toLowerCase().trim()));
  const conflicts = unique.size > 1 ? [`Found ${unique.size} distinct claims about "${input.query}"`] : [];
  const citations = evidence.map(e => e.source);
  const report = `Research report on "${input.query}":\n${evidence.map(e => `- [${e.source}]: ${e.excerpt}`).join('\n')}\n${conflicts.length > 0 ? 'Conflicts: ' + conflicts.join('; ') : 'No conflicts found.'}`;
  return { evidence, conflicts, report, citations };
}
