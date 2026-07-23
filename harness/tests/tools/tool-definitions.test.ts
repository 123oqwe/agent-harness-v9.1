import { describe, it, expect } from 'vitest';
import { createPhase1ToolDefinitions, PHASE1_TOOL_NAMES } from '../../tools/tool-definitions.js';

describe('Phase 1 Tool Definitions', () => {
  it('defines exactly 9 tools', () => {
    const defs = createPhase1ToolDefinitions();
    expect(defs).toHaveLength(9);
  });

  it('all 9 tool names are present', () => {
    expect(PHASE1_TOOL_NAMES).toHaveLength(9);
    expect(PHASE1_TOOL_NAMES).toContain('read_file');
    expect(PHASE1_TOOL_NAMES).toContain('write_file');
    expect(PHASE1_TOOL_NAMES).toContain('edit_file');
    expect(PHASE1_TOOL_NAMES).toContain('list_directory');
    expect(PHASE1_TOOL_NAMES).toContain('search_files');
    expect(PHASE1_TOOL_NAMES).toContain('execute_command');
    expect(PHASE1_TOOL_NAMES).toContain('create_artifact');
    expect(PHASE1_TOOL_NAMES).toContain('ask_user');
    expect(PHASE1_TOOL_NAMES).toContain('parse_document');
  });

  it('each definition has required ToolSpec fields', () => {
    const defs = createPhase1ToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeDefined();
      expect(def.version).toBe('1.0.0');
      expect(def.domains.length).toBeGreaterThan(0);
      expect(def.implementation_status).toBe('production_certified');
      expect(def.effect_model).toBeDefined();
      expect(def.maturity).toBe('production_certified');
    }
  });

  it('execute_command has sandbox policy enabled', () => {
    const defs = createPhase1ToolDefinitions();
    const exec = defs.find(d => d.name === 'execute_command');
    expect(exec!.sandbox_policy).toEqual({ sandbox: true });
  });

  it('read_file has read-only effect model', () => {
    const defs = createPhase1ToolDefinitions();
    const read = defs.find(d => d.name === 'read_file');
    expect((read!.effect_model as { operation: string }).operation).toBe('read');
  });
});
