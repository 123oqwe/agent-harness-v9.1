import { describe, it, expect } from 'vitest';
import { createTuiState, handleKey, addMessage, setFileDiff, setBudget, renderTui, renderScreenReaderFallback, parseCommand } from '../../../apps/tui/src/tui.js';

describe('AH-UI-TUI-001: Terminal UI with diff rendering', () => {
  it('creates initial state with conversation pane active', () => {
    const state = createTuiState();
    expect(state.activePane).toBe('conversation');
    expect(state.messages).toHaveLength(0);
    expect(state.commandMode).toBe(false);
  });

  it('navigates panes with Tab', () => {
    let state = createTuiState();
    state = handleKey(state, 'Tab');
    expect(state.activePane).toBe('tool_status');
    state = handleKey(state, 'Tab');
    expect(state.activePane).toBe('file_diff');
    state = handleKey(state, 'Tab');
    expect(state.activePane).toBe('conversation');
  });

  it('enters command mode with :', () => {
    let state = createTuiState();
    state = handleKey(state, ':');
    expect(state.commandMode).toBe(true);
  });

  it('parses :approve command', () => {
    expect(parseCommand(':approve')).toEqual({ action: 'approve' });
    expect(parseCommand(':a')).toEqual({ action: 'approve' });
  });

  it('parses :reject command', () => {
    expect(parseCommand(':reject')).toEqual({ action: 'reject' });
    expect(parseCommand(':r')).toEqual({ action: 'reject' });
  });

  it('parses :steer command with payload', () => {
    expect(parseCommand(':steer change direction')).toEqual({ action: 'steer', payload: 'change direction' });
  });

  it('parses :quit command', () => {
    expect(parseCommand(':quit')).toEqual({ action: 'quit' });
    let state = createTuiState();
    state = { ...state, commandMode: true };
    state = handleKey(state, ':quit');
    expect(state.exitRequested).toBe(true);
  });

  it('renders diff in file_diff pane', () => {
    let state = createTuiState();
    state = setFileDiff(state, ['old line 1', 'shared'], ['new line 1', 'shared']);
    expect(state.fileDiff).toBeDefined();
    expect(state.fileDiff!.added).toContain('new line 1');
    expect(state.fileDiff!.removed).toContain('old line 1');
  });

  it('shows budget indicator', () => {
    let state = createTuiState();
    state = setBudget(state, { used: 500, total: 1000, unit: 'tokens' });
    const rendered = renderTui(state);
    expect(rendered).toContain('Budget: 500/1000 tokens');
  });

  it('marks untrusted content visually', () => {
    let state = createTuiState();
    state = addMessage(state, { role: 'tool', text: 'suspicious content', trusted: false, timestamp: '2024-01-01' });
    const rendered = renderTui(state);
    expect(rendered).toContain('[UNTRUSTED]');
  });

  it('provides screen reader fallback', () => {
    let state = createTuiState();
    state = addMessage(state, { role: 'user', text: 'hello', trusted: true, timestamp: '2024-01-01' });
    const fallback = renderScreenReaderFallback(state);
    expect(fallback).toContain('Active pane: conversation');
    expect(fallback).toContain('trusted');
  });
});
