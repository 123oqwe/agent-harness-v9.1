/** AH-DOC-VERTICAL-001: thin adapter. Read doc → summarize → cite pages. */
import type { TaskContract } from '../contracts/index.js';
import type { Harness, HarnessOutcome } from '../harness.js';

export interface DocVerticalInput { path: string; max_pages?: number | undefined }
export interface DocVerticalOutput {
  summary: string;
  citations: { page: number; excerpt: string }[];
  outcome: HarnessOutcome;
}

export function docTaskContract(input: DocVerticalInput): TaskContract {
  return {
    goal: `Read document at ${input.path}, extract text, summarize content, cite page numbers`,
    success_criteria: [
      { criterion: 'document parsed and text extracted', verification_method: 'deterministic' },
      { criterion: 'summary mentions key content', verification_method: 'semantic' },
      { criterion: 'citations reference correct page numbers', verification_method: 'deterministic' },
    ],
    constraints: [{ type: 'privacy', value: 'local_only' }],
  };
}

export async function runDocVertical(harness: Harness, input: DocVerticalInput): Promise<DocVerticalOutput> {
  const outcome = await harness.run(docTaskContract(input), `doc-${Date.now()}`);
  const events = outcome.session.getEvents();
  const toolResults = events.filter(e => e.type === 'tool_result');
  const parseResult = toolResults.find(e => (e.data as { tool: string }).tool === 'parse_document');
  let citations: { page: number; excerpt: string }[] = [];
  if (parseResult) {
    try {
      const parseData = JSON.parse((parseResult.data as { result?: string }).result ?? '') as { pages?: Array<{ page: number; text: string }> };
      citations = (parseData.pages ?? []).map(p => ({
        page: p.page,
        excerpt: (p.text.split(/[.!?]/)[0] ?? '').trim().slice(0, 120),
      }));
    } catch { /* empty citations on parse failure */ }
  }
  return {
    summary: outcome.loop_result.turns.at(-1)?.model.content ?? '',
    citations,
    outcome,
  };
}
