/** AH-RESEARCH-VERTICAL-001: sources -> LLM evidence analysis -> report with conflicts. */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { readFile } from '../tools/read-file.js';

export interface ResearchVerticalInput { sources: string[]; query: string }
export interface ResearchVerticalOutput {
  evidence: { source: string; excerpt: string }[];
  conflicts: string[];
  report: string;
  citations: string[];
}

export type ModelCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export async function runResearchVertical(
  vfs: VirtualFilesystem,
  input: ResearchVerticalInput,
  modelCall?: ModelCallFn,
): Promise<ResearchVerticalOutput> {
  const evidence: { source: string; excerpt: string }[] = [];
  for (const src of input.sources) {
    try {
      const r = await readFile(vfs, { path: src });
      const idx = r.content.toLowerCase().indexOf(input.query.toLowerCase());
      if (idx >= 0) evidence.push({ source: src, excerpt: r.content.slice(Math.max(0, idx - 50), idx + 100) });
    } catch { /* skip */ }
  }

  let report: string;
  let conflicts: string[];
  if (modelCall) {
    const evidenceText = evidence.map(e => `[${e.source}] ${e.excerpt}`).join('\n');
    report = await modelCall(
      'You are a research analyst. Analyze the evidence, identify conflicts, and write a report with citations.',
      `Query: ${input.query}\n\nEvidence:\n${evidenceText}`,
    );
    conflicts = report.toLowerCase().includes('conflict') ? ['LLM identified conflicts (see report)'] : [];
  } else {
    const excerpts = evidence.map(e => e.excerpt);
    const unique = new Set(excerpts.map(e => e.toLowerCase().trim()));
    conflicts = unique.size > 1 ? [`Found ${unique.size} distinct claims about "${input.query}"`] : [];
    report = `Research report on "${input.query}":\n${evidence.map(e => `- [${e.source}]: ${e.excerpt}`).join('\n')}\n${conflicts.length > 0 ? 'Conflicts: ' + conflicts.join('; ') : 'No conflicts found.'}`;
  }
  return { evidence, conflicts, report, citations: evidence.map(e => e.source) };
}
