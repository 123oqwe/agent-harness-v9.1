/** AH-TOOL-ASK-001: synchronous ask_user tool. Returns a question + awaits answer. */
export interface AskUserInput { question: string; options?: string[] }
export interface AskUserOutput { question: string; answer: string }

export type AskUserHandler = (question: string, options?: string[]) => Promise<string>;

export async function askUser(handler: AskUserHandler, input: AskUserInput): Promise<AskUserOutput> {
  const answer = await handler(input.question, input.options);
  return { question: input.question, answer };
}
