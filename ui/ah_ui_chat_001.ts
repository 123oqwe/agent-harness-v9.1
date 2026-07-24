/** AH-UI-CHAT-001: Chat is a Harness adapter, never an arbitrary responder. */
import type { TaskContract } from '../contracts/index.js';
import type { Harness } from '../harness.js';
import type { UiResult } from './ui-state.js';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; timestamp: string }
export class ChatController {
  private messages: ChatMessage[] = [];
  private loading = false;
  private sequence = 0;

  constructor(
    private readonly harness: Pick<Harness, 'run'>,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async send(content: string): Promise<UiResult<ChatMessage>> {
    if (!content.trim()) return { state: 'error', error: 'empty message' };
    this.messages.push({ role: 'user', content, timestamp: this.clock() });
    this.loading = true;
    try {
      const task: TaskContract = {
        goal: content.trim(),
        success_criteria: [
          {
            criterion: 'answer addresses the user request',
            verification_method: 'semantic',
          },
        ],
        constraints: [],
      };
      this.sequence += 1;
      const outcome = await this.harness.run(task, `chat-${this.sequence}`);
      if (!outcome.success) {
        this.loading = false;
        return {
          state: 'error',
          error: `Harness run failed: ${outcome.loop_result.termination_reason}`,
        };
      }
      const reply = outcome.loop_result.turns.at(-1)?.model.content ?? '';
      const msg: ChatMessage = {
        role: 'assistant',
        content: reply,
        timestamp: this.clock(),
      };
      this.messages.push(msg);
      this.loading = false;
      return { state: 'success', data: msg };
    } catch (e) {
      this.loading = false;
      return { state: 'error', error: (e as Error).message };
    }
  }
  list(): UiResult<ChatMessage[]> { return { state: this.messages.length === 0 ? 'empty' : 'success', data: [...this.messages] }; }
  isLoading(): boolean { return this.loading; }
}
