/** AH-TOOL-002: ask_user - synchronous, cancellable prompt without fabricating answers */
export interface AskUserInput {
  question: string;
  options?: string[];
  timeout_ms?: number;
}

export interface AskUserResult {
  question: string;
  answer: string | null;
  cancelled: boolean;
  timed_out: boolean;
}

export type AskUserHandler = (question: string, options?: string[]) => Promise<string | null>;

export function createAskUserTool(handler?: AskUserHandler) {
  return {
    name: 'ask_user',
    async execute(input: AskUserInput, signal?: AbortSignal): Promise<AskUserResult> {
      if (signal?.aborted) {
        return { question: input.question, answer: null, cancelled: true, timed_out: false };
      }
      if (!handler) {
        return { question: input.question, answer: null, cancelled: false, timed_out: true };
      }
      try {
        const answer = await handler(input.question, input.options);
        return { question: input.question, answer, cancelled: false, timed_out: false };
      } catch {
        return { question: input.question, answer: null, cancelled: false, timed_out: true };
      }
    },
  };
}
