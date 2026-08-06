/**
 * AH-UI-TUI-001: Terminal UI with diff rendering, split panes, keyboard nav, command mode.
 * Uses readline (Node built-in, zero new dependencies).
 */
import { renderDiff, type TuiDiff } from './index.js';

export type PaneId = 'conversation' | 'tool_status' | 'file_diff';
export type CommandResult = { action: 'approve' | 'reject' | 'steer' | 'quit' | 'noop'; payload?: string };

export interface TuiConfig {
  budget_indicator?: boolean;
  untrusted_marker?: string;
}

export interface TuiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  trusted: boolean;
  timestamp: string;
}

export interface TuiBudget {
  used: number;
  total: number;
  unit: 'tokens' | 'ms';
}

export interface TuiState {
  messages: TuiMessage[];
  activePane: PaneId;
  fileDiff: TuiDiff | null;
  budget: TuiBudget | null;
  commandMode: boolean;
  exitRequested: boolean;
}

export function createTuiState(): TuiState {
  return {
    messages: [],
    activePane: 'conversation',
    fileDiff: null,
    budget: null,
    commandMode: false,
    exitRequested: false,
  };
}

/** Parse a command-mode input string into a CommandResult. */
export function parseCommand(input: string): CommandResult {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === ':approve' || trimmed === ':a') return { action: 'approve' };
  if (trimmed === ':reject' || trimmed === ':r') return { action: 'reject' };
  if (trimmed === ':quit' || trimmed === ':q' || trimmed === ':exit') return { action: 'quit' };
  if (trimmed.startsWith(':steer ')) return { action: 'steer', payload: input.slice(7).trim() };
  return { action: 'noop' };
}

/** Handle keyboard input and update state. */
export function handleKey(state: TuiState, key: string): TuiState {
  if (state.commandMode) {
    if (key === 'Escape') {
      return { ...state, commandMode: false };
    }
    const result = parseCommand(key);
    if (result.action === 'quit') {
      return { ...state, exitRequested: true, commandMode: false };
    }
    return { ...state, commandMode: false };
  }
  switch (key) {
    case 'Tab':
      return { ...state, activePane: nextPane(state.activePane) };
    case 'Shift+Tab':
      return { ...state, activePane: prevPane(state.activePane) };
    case ':':
      return { ...state, commandMode: true };
    case 'Escape':
      return { ...state, exitRequested: true };
    default:
      return state;
  }
}

function nextPane(current: PaneId): PaneId {
  const panes: PaneId[] = ['conversation', 'tool_status', 'file_diff'];
  const idx = panes.indexOf(current);
  return panes[(idx + 1) % panes.length]!;
}

function prevPane(current: PaneId): PaneId {
  const panes: PaneId[] = ['conversation', 'tool_status', 'file_diff'];
  const idx = panes.indexOf(current);
  return panes[(idx - 1 + panes.length) % panes.length]!;
}

/** Add a message to the conversation pane. */
export function addMessage(state: TuiState, message: TuiMessage): TuiState {
  return { ...state, messages: [...state.messages, message] };
}

/** Update the file diff pane. */
export function setFileDiff(state: TuiState, oldLines: readonly string[], newLines: readonly string[]): TuiState {
  return { ...state, fileDiff: renderDiff(oldLines, newLines) };
}

/** Update the budget indicator. */
export function setBudget(state: TuiState, budget: TuiBudget): TuiState {
  return { ...state, budget };
}

/** Render the TUI as a string (for testing or terminal output). */
export function renderTui(state: TuiState): string {
  const lines: string[] = [];
  const paneMarker = (id: PaneId) => state.activePane === id ? '[*]' : '[ ]';
  lines.push(`${paneMarker('conversation')} Conversation:`);
  for (const msg of state.messages.slice(-5)) {
    const marker = msg.trusted ? '' : ' [UNTRUSTED]';
    lines.push(`  ${msg.role}: ${msg.text.slice(0, 80)}${marker}`);
  }
  lines.push('');
  lines.push(`${paneMarker('tool_status')} Tool Status:`);
  lines.push('  (no active tools)');
  lines.push('');
  lines.push(`${paneMarker('file_diff')} File Diff:`);
  if (state.fileDiff) {
    for (const added of state.fileDiff.added.slice(0, 5)) lines.push(`  + ${added}`);
    for (const removed of state.fileDiff.removed.slice(0, 5)) lines.push(`  - ${removed}`);
  } else {
    lines.push('  (no diff)');
  }
  lines.push('');
  if (state.budget) {
    const pct = state.budget.total > 0 ? Math.round((state.budget.used / state.budget.total) * 100) : 0;
    lines.push(`Budget: ${state.budget.used}/${state.budget.total} ${state.budget.unit} (${pct}%)`);
  }
  if (state.commandMode) {
    lines.push(':');
  }
  return lines.join('\n');
}

/** Screen reader fallback: render as plain text without visual markers. */
export function renderScreenReaderFallback(state: TuiState): string {
  const lines: string[] = [];
  lines.push(`Active pane: ${state.activePane}`);
  lines.push(`Messages: ${state.messages.length}`);
  for (const msg of state.messages) {
    const trust = msg.trusted ? 'trusted' : 'untrusted';
    lines.push(`${msg.role} (${trust}): ${msg.text}`);
  }
  if (state.budget) {
    lines.push(`Budget: ${state.budget.used} of ${state.budget.total} ${state.budget.unit} used`);
  }
  return lines.join('\n');
}
