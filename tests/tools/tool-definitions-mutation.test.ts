import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createPhase1ToolDefinitions, PHASE1_TOOL_NAMES } from '../../tools/tool-definitions.js';

describe('Tool Definitions mutation-killing tests', () => {
  const allDefs = createPhase1ToolDefinitions();
  const ORIGINAL_PHASE1 = ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'execute_command', 'create_artifact', 'ask_user', 'parse_document'] as const;
  const defs = allDefs.filter(d => (ORIGINAL_PHASE1 as readonly string[]).includes(d.name));
  const byName = (n: string) => defs.find(d => d.name === n)!;

  it('matches the frozen Phase 1 ToolSpec catalog fingerprint', () => {
    // Only check the original 9 Phase 1 tools; new tools are additive
    expect(
      createHash('sha256').update(JSON.stringify(defs)).digest('hex'),
    ).toBe('12244684f857514032f0ba552cf2c219d7e9e1dd28fd45ebcdf515c937c35173');
  });

  it('read_file has correct effect_model', () => {
    const d = byName('read_file');
    expect(d.effect_model).toEqual({ locality: 'local', operation: 'read', reversibility: 'guaranteed', data_egress: 'none', network_access: false, credential_access: false, blast_radius: 'single_resource' });
  });
  it('read_file has timeout 5000', () => { expect(byName('read_file').timeout_policy).toEqual({ timeout_ms: 5000 }); });
  it('read_file is idempotent', () => { expect(byName('read_file').idempotency_policy).toEqual({ idempotent: true }); });
  it('read_file has no sandbox', () => { expect(byName('read_file').sandbox_policy).toEqual({ sandbox: false }); });
  it('read_file has no network', () => { expect(byName('read_file').network_policy).toEqual({ network_required: false }); });
  it('read_file verification_adapter is read_back', () => { expect(byName('read_file').verification_adapter).toBe('read_back'); });
  it('read_file risk_feature_extractor is default', () => { expect(byName('read_file').risk_feature_extractor).toBe('default'); });

  it('write_file has write operation', () => { expect((byName('write_file').effect_model as Record<string, unknown>).operation).toBe('write'); });
  it('write_file has best_effort reversibility', () => { expect((byName('write_file').effect_model as Record<string, unknown>).reversibility).toBe('best_effort'); });
  it('write_file is idempotent', () => { expect(byName('write_file').idempotency_policy).toEqual({ idempotent: true }); });
  it('write_file domains include writing', () => { expect(byName('write_file').domains).toContain('writing'); });

  it('edit_file has write operation', () => { expect((byName('edit_file').effect_model as Record<string, unknown>).operation).toBe('write'); });
  it('edit_file domains are coding only', () => { expect(byName('edit_file').domains).toEqual(['coding']); });
  it('edit_file is NOT idempotent (patch application is not repeatable)', () => { expect(byName('edit_file').idempotency_policy).toEqual({ idempotent: false }); });

  it('list_directory has read operation', () => { expect((byName('list_directory').effect_model as Record<string, unknown>).operation).toBe('read'); });
  it('list_directory domains include documents', () => { expect(byName('list_directory').domains).toContain('documents'); });

  it('search_files has bounded_set blast_radius', () => { expect((byName('search_files').effect_model as Record<string, unknown>).blast_radius).toBe('bounded_set'); });
  it('search_files timeout is 10000', () => { expect(byName('search_files').timeout_policy).toEqual({ timeout_ms: 10000 }); });

  it('execute_command has execute operation', () => { expect((byName('execute_command').effect_model as Record<string, unknown>).operation).toBe('execute'); });
  it('execute_command has none reversibility', () => { expect((byName('execute_command').effect_model as Record<string, unknown>).reversibility).toBe('none'); });
  it('execute_command has workspace blast_radius', () => { expect((byName('execute_command').effect_model as Record<string, unknown>).blast_radius).toBe('workspace'); });
  it('execute_command sandbox is true', () => { expect(byName('execute_command').sandbox_policy).toEqual({ sandbox: true }); });
  it('execute_command timeout is 30000', () => { expect(byName('execute_command').timeout_policy).toEqual({ timeout_ms: 30000 }); });
  it('execute_command is NOT idempotent', () => { expect(byName('execute_command').idempotency_policy).toEqual({ idempotent: false }); });

  it('create_artifact has create operation', () => { expect((byName('create_artifact').effect_model as Record<string, unknown>).operation).toBe('create'); });
  it('create_artifact domains include planning', () => { expect(byName('create_artifact').domains).toContain('planning'); });

  it('ask_user has communicate operation', () => { expect((byName('ask_user').effect_model as Record<string, unknown>).operation).toBe('communicate'); });
  it('ask_user has self blast_radius', () => { expect((byName('ask_user').effect_model as Record<string, unknown>).blast_radius).toBe('self'); });
  it('ask_user timeout is 60000', () => { expect(byName('ask_user').timeout_policy).toEqual({ timeout_ms: 60000 }); });
  it('ask_user domains include personal_assistant', () => { expect(byName('ask_user').domains).toContain('personal_assistant'); });

  it('parse_document has read operation', () => { expect((byName('parse_document').effect_model as Record<string, unknown>).operation).toBe('read'); });
  it('parse_document domains include research', () => { expect(byName('parse_document').domains).toContain('research'); });
  it('parse_document timeout is 10000', () => { expect(byName('parse_document').timeout_policy).toEqual({ timeout_ms: 10000 }); });

  it('all tools have version 1.0.0', () => { for (const d of defs) expect(d.version).toBe('1.0.0'); });
  it('all tools have production_certified status', () => { for (const d of defs) expect(d.implementation_status).toBe('production_certified'); });
  it('all tools have production_certified maturity', () => { for (const d of defs) expect(d.maturity).toBe('production_certified'); });
  it('all tools have no credential_requirements', () => { for (const d of defs) expect(d.credential_requirements).toEqual([]); });
  it('all tools have egress none', () => { for (const d of defs) expect(d.data_egress_policy).toEqual({ egress: 'none' }); });
  it('all tools have receipt_schema_ref', () => { for (const d of defs) expect(d.receipt_schema_ref).toBe('schemas/receipt.json'); });
  it('all tools have cancellable true', () => { for (const d of defs) expect(d.cancellation_policy).toEqual({ cancellable: true }); });
  it('all tools have max_retries 0', () => { for (const d of defs) expect(d.retry_policy).toEqual({ max_retries: 0 }); });
  it('all tools have no preconditions', () => { for (const d of defs) expect(d.preconditions).toEqual([]); });
  it('all tools have no postconditions', () => { for (const d of defs) expect(d.postconditions).toEqual([]); });
  it('all tools have local locality', () => { for (const d of defs) expect((d.effect_model as Record<string, unknown>).locality).toBe('local'); });
  it('all tools have no data_egress', () => { for (const d of defs) expect((d.effect_model as Record<string, unknown>).data_egress).toBe('none'); });
  it('all tools have network_access false', () => { for (const d of defs) expect((d.effect_model as Record<string, unknown>).network_access).toBe(false); });
  it('all tools have credential_access false', () => { for (const d of defs) expect((d.effect_model as Record<string, unknown>).credential_access).toBe(false); });
  it('all tools have network_required false', () => { for (const d of defs) expect(d.network_policy).toEqual({ network_required: false }); });

  it('PHASE1_TOOL_NAMES has at least 9 names', () => { expect(PHASE1_TOOL_NAMES.length).toBeGreaterThanOrEqual(9); });
  it('PHASE1_TOOL_NAMES matches definition names', () => {
    const defNames = defs.map(d => d.name).sort();
    const phaseNames = [...PHASE1_TOOL_NAMES].sort();
    // defs is filtered to original 9; PHASE1_TOOL_NAMES includes new tools
    expect(phaseNames).toEqual(expect.arrayContaining(defNames));
  });
});
