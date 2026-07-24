/** AH-RESEARCH-VERTICAL-001: thin adapter. Sources → evidence → report. */
import type { TaskContract } from '../contracts/index.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface ResearchVerticalInput { sources: string[]; query: string }
export interface ResearchVerticalOutput {
  evidence: { source: string; excerpt: string }[];
  conflicts: string[];
  report: string;
  citations: string[];
  outcome: HarnessOutcome;
}

export function researchTaskContract(input: ResearchVerticalInput): TaskContract {
  return {
    goal: `Research query "${input.query}" using sources: ${input.sources.join(', ')}. Organize evidence, identify conflicts, cite sources.`,
    success_criteria: [
      { criterion: 'all sources read', verification_method: 'deterministic' },
      { criterion: 'evidence organized with citations', verification_method: 'deterministic' },
      { criterion: 'conflicts identified', verification_method: 'semantic' },
      { criterion: 'report is coherent', verification_method: 'semantic' },
    ],
    constraints: [{ type: 'privacy', value: 'local_only' }],
  };
}

export async function runResearchVertical(harness: Harness, input: ResearchVerticalInput): Promise<ResearchVerticalOutput> {
  const outcome = await harness.run(researchTaskContract(input), `research-${Date.now()}`);
  const events = outcome.session.getEvents();
  const toolResults = events.filter(e => e.type === 'tool_result');
  const evidence: { source: string; excerpt: string }[] = [];
  for (const src of input.sources) {
    const readResult = toolResults.find(e => {
      const data = e.data as { tool: string; result?: string };
      return data.tool === 'read_file' && (data.result ?? '').includes(src);
    });
    if (readResult) {
      const content = (() => { try { return JSON.parse((readResult.data as { result?: string }).result ?? '').content ?? ''; } catch { return ''; } })();
      const idx = content.toLowerCase().indexOf(input.query.toLowerCase());
      if (idx >= 0) evidence.push({ source: src, excerpt: content.slice(Math.max(0, idx - 50), idx + 100) });
    }
  }
  const conflicts = evidence.length > 1 ? [`Found ${new Set(evidence.map(e => e.excerpt.toLowerCase().trim())).size} distinct claims`] : [];
  return {
    evidence,
    conflicts,
    report: outcome.loop_result.turns.at(-1)?.model.content ?? '',
    citations: evidence.map(e => e.source),
    outcome,
  };
}
