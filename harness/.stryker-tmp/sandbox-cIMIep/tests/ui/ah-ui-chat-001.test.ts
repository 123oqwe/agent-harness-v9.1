// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { ChatController } from '../../ui/ah_ui_chat_001.js';
describe('AH-UI-CHAT-001 chat', () => {
  it('empty state when no messages', () => { const c = new ChatController(); expect(c.list().state).toBe('empty'); });
  it('send empty message error', () => { const c = new ChatController(); expect(c.send('  ', async () => 'x').state).toBe('error'); });
  it('receive success', async () => { const c = new ChatController(); c.send('hello', async () => 'x'); const r = await c.receive(async () => 'hi', 'hello'); expect(r.state).toBe('success'); expect(r.data!.content).toBe('hi'); });
  it('receive error', async () => { const c = new ChatController(); c.send('hi', async () => 'x'); const r = await c.receive(async () => { throw new Error('fail'); }, 'hi'); expect(r.state).toBe('error'); });
});
