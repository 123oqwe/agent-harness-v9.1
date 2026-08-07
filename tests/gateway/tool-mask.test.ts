import { describe, it, expect } from 'vitest';
import { ToolMaskStateMachine } from '../../gateway/tool-mask.js';

describe('ToolMaskStateMachine', () => {
  it('starts in idle state with masking disabled', () => {
    const tm = new ToolMaskStateMachine();
    expect(tm.currentState).toBe('idle');
    expect(tm.isEnabled).toBe(false);
  });

  it('allows all tools when disabled', () => {
    const tm = new ToolMaskStateMachine({ enabled: false });
    const result = tm.isToolAllowed('write_file');
    expect(result.allowed).toBe(true);
  });

  it('classifies tools into correct groups', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    expect(tm.classifyTool('read_file')).toBe('fs_read');
    expect(tm.classifyTool('write_file')).toBe('fs_write');
    expect(tm.classifyTool('edit_file')).toBe('fs_write');
    expect(tm.classifyTool('list_directory')).toBe('fs_read');
    expect(tm.classifyTool('search_files')).toBe('fs_read');
    expect(tm.classifyTool('web_fetch')).toBe('web');
    expect(tm.classifyTool('execute_command')).toBe('system');
    expect(tm.classifyTool('create_artifact')).toBe('artifact');
    expect(tm.classifyTool('unknown_tool')).toBeNull();
  });

  it('allows all tools in executing state', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('executing');
    expect(tm.isToolAllowed('read_file').allowed).toBe(true);
    expect(tm.isToolAllowed('write_file').allowed).toBe(true);
    expect(tm.isToolAllowed('execute_command').allowed).toBe(true);
  });

  it('masks write tools in planning state', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('planning');
    expect(tm.isToolAllowed('read_file').allowed).toBe(true);
    expect(tm.isToolAllowed('write_file').allowed).toBe(false);
    expect(tm.isToolAllowed('edit_file').allowed).toBe(false);
  });

  it('masks all tools in idle state', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    expect(tm.isToolAllowed('read_file').allowed).toBe(false);
    expect(tm.isToolAllowed('write_file').allowed).toBe(false);
  });

  it('allows only fs_read and system in setup state', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('setup');
    expect(tm.isToolAllowed('read_file').allowed).toBe(true);
    expect(tm.isToolAllowed('execute_command').allowed).toBe(true);
    expect(tm.isToolAllowed('write_file').allowed).toBe(false);
    expect(tm.isToolAllowed('web_fetch').allowed).toBe(false);
  });

  it('allows only fs_read and system in verifying state', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('verifying');
    expect(tm.isToolAllowed('read_file').allowed).toBe(true);
    expect(tm.isToolAllowed('execute_command').allowed).toBe(true);
    expect(tm.isToolAllowed('write_file').allowed).toBe(false);
  });

  it('unclassified tools are allowed by default', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('planning');
    const result = tm.isToolAllowed('unknown_custom_tool');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('unclassified');
  });

  it('masked tools have reason in result', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('planning');
    const result = tm.isToolAllowed('write_file');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('masked');
    expect(result.group).toBe('fs_write');
  });

  it('getPromptToolSet returns all tools when disabled', () => {
    const tm = new ToolMaskStateMachine({ enabled: false });
    const tools = ['read_file', 'write_file', 'execute_command'];
    expect(tm.getPromptToolSet(tools)).toEqual(tools);
  });

  it('getPromptToolSet returns all tools even when enabled (stable prefix)', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('planning');
    const tools = ['read_file', 'write_file', 'execute_command'];
    expect(tm.getPromptToolSet(tools)).toEqual(tools);
  });

  it('getMaskedTools returns tools not allowed in current state', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('planning');
    const masked = tm.getMaskedTools(['read_file', 'write_file', 'edit_file']);
    expect(masked).toContain('write_file');
    expect(masked).toContain('edit_file');
    expect(masked).not.toContain('read_file');
  });

  it('getMaskHint returns null when no tools masked', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('executing');
    expect(tm.getMaskHint(['read_file', 'write_file'])).toBeNull();
  });

  it('getMaskHint returns string when tools masked', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('planning');
    const hint = tm.getMaskHint(['read_file', 'write_file']);
    expect(hint).not.toBeNull();
    expect(hint).toContain('write_file');
    expect(hint).toContain('tool_mask');
  });

  it('getMaskHint returns null when disabled', () => {
    const tm = new ToolMaskStateMachine({ enabled: false });
    expect(tm.getMaskHint(['write_file'])).toBeNull();
  });

  it('transition records mask history', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('executing');
    tm.transition('verifying');
    const history = tm.getMaskHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.to).toBe('executing');
    expect(history[1]!.to).toBe('verifying');
  });

  it('reset clears state and history', () => {
    const tm = new ToolMaskStateMachine({ enabled: true });
    tm.transition('executing');
    tm.reset();
    expect(tm.currentState).toBe('idle');
    expect(tm.getMaskHistory()).toHaveLength(0);
  });
});
