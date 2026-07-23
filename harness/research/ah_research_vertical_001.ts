/** AH-RESEARCH-001: Research vertical - read sources, organize claims, cite */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { searchFiles } from '../tools/search-files.js';

export interface ResearchVerticalInput {
  source_directory: string;
  research_question: string;
}

export interface ResearchVerticalResult {
  claims: { source: string; claim: string; citation: string }[];
  summary: string;
}

export function runResearchVertical(vfs: VirtualFilesystem, input: ResearchVerticalInput): ResearchVerticalResult {
  const search = searchFiles(vfs, { directory: input.source_directory, pattern: input.research_question.split(' ')[0] || 'topic' });
  const claims = search.matches.map((m) => ({
    source: m.file,
    claim: m.line,
    citation: `${m.file}:${m.line_number}`,
  }));
  return { claims, summary: `Found ${claims.length} relevant sources for: ${input.research_question}` };
}
