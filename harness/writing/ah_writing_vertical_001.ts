/** AH-WRITING-VERTICAL-001: brief -> LLM draft -> self-check -> output. */
export interface WritingVerticalInput { brief: string; requirements: string[] }
export interface WritingVerticalOutput { draft: string; self_check: { requirement: string; met: boolean }[]; output: string }

export type ModelCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export async function runWritingVertical(
  input: WritingVerticalInput,
  modelCall?: ModelCallFn,
): Promise<WritingVerticalOutput> {
  let draft: string;
  if (modelCall) {
    draft = await modelCall(
      'You are a writing assistant. Write a draft based on the brief that meets all requirements.',
      `Brief: ${input.brief}\nRequirements: ${input.requirements.join('; ')}`,
    );
  } else {
    draft = `# Draft\n\nBased on the brief: ${input.brief}\n\n${input.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
  }
  const self_check = input.requirements.map(r => ({ requirement: r, met: draft.toLowerCase().includes(r.toLowerCase().split(' ')[0]!) }));
  const allMet = self_check.every(s => s.met);
  const output = allMet ? draft : draft + '\n\n[WARNING: some requirements may need further work]';
  return { draft, self_check, output };
}
