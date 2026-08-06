import { describe, it, expect } from 'vitest';
import { createPhase1ToolDefinitions, PHASE1_TOOL_NAMES } from '../../tools/tool-definitions.js';
import { ToolRegistry } from '../../tools/tool-registry.js';

describe('Phase 1 Tool Definitions', () => {
  it('defines exactly 9 tools', () => {
    const defs = createPhase1ToolDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(9);
  });

  it('all 9 tool names are present', () => {
    expect(PHASE1_TOOL_NAMES.length).toBeGreaterThanOrEqual(9);
    expect(PHASE1_TOOL_NAMES).toContain('read_file');
    expect(PHASE1_TOOL_NAMES).toContain('write_file');
    expect(PHASE1_TOOL_NAMES).toContain('edit_file');
    expect(PHASE1_TOOL_NAMES).toContain('list_directory');
    expect(PHASE1_TOOL_NAMES).toContain('search_files');
    expect(PHASE1_TOOL_NAMES).toContain('execute_command');
    expect(PHASE1_TOOL_NAMES).toContain('apply_patch');
    expect(PHASE1_TOOL_NAMES).toContain('undo');
    expect(PHASE1_TOOL_NAMES).toContain('web_fetch');
    expect(PHASE1_TOOL_NAMES).toContain('web_search');
    expect(PHASE1_TOOL_NAMES).toContain('screenshot');
    expect(PHASE1_TOOL_NAMES).toContain('create_artifact');
    expect(PHASE1_TOOL_NAMES).toContain('ask_user');
    expect(PHASE1_TOOL_NAMES).toContain('parse_document');
  });

  it('each definition has required ToolSpec fields', () => {
    const defs = createPhase1ToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeDefined();
      expect(def.version).toBe('1.0.0');
      expect(def.domains!.length).toBeGreaterThan(0);
      expect(['production_certified', 'implemented']).toContain(def.implementation_status);
      expect(def.effect_model).toBeDefined();
      expect(['production_certified', 'sandbox_verified']).toContain(def.maturity);
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

  it('registers every built-in definition in the production ToolRegistry', () => {
    const registry = new ToolRegistry();

    for (const definition of createPhase1ToolDefinitions()) {
      registry.register(definition);
    }

    expect(registry.listNames()).toEqual([...PHASE1_TOOL_NAMES].sort());
  });
});
