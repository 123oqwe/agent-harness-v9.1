/** AH-UI-CHAT-001: Chat screen with real API dependencies and states. */
import type { UiResult } from './ui-state.js';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; timestamp: string }
export class ChatController {
  private messages: ChatMessage[] = [];
  private loading = false;
  send(content: string, responder: (msg: string) => Promise<string>): UiResult<ChatMessage> {
    if (!content.trim()) return { state: 'error', error: 'empty message' };
    this.messages.push({ role: 'user', content, timestamp: new Date().toISOString() });
    this.loading = true;
    return { state: 'loading', data: this.messages[this.messages.length - 1] };
  }
  async receive(responder: (msg: string) => Promise<string>, userMsg: string): Promise<UiResult<ChatMessage>> {
    this.loading = true;
    try {
      const reply = await responder(userMsg);
      const msg: ChatMessage = { role: 'assistant', content: reply, timestamp: new Date().toISOString() };
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
