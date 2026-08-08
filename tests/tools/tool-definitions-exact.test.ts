import { describe, it, expect } from 'vitest';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

const defs = createPhase1ToolDefinitions();
const get = (name: string) => defs.find(d => d.name === name)!;

describe('tool-definitions exact property values (mutation-killing)', () => {
  describe('apply_patch exact properties', () => {
    const d = get('apply_patch');
    it('has exact effect_model', () => {
      expect(d.effect_model).toEqual({
        locality: 'local', operation: 'write', reversibility: 'best_effort',
        data_egress: 'none', network_access: false, credential_access: false,
        blast_radius: 'bounded_set',
      });
    });
    it('has exact timeout_policy', () => { expect(d.timeout_policy).toEqual({ timeout_ms: 10000 }); });
    it('has exact cancellation_policy', () => { expect(d.cancellation_policy).toEqual({ cancellable: true }); });
    it('has exact retry_policy', () => { expect(d.retry_policy).toEqual({ max_retries: 0 }); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: false }); });
    it('has exact sandbox_policy', () => { expect(d.sandbox_policy).toEqual({ sandbox: false }); });
    it('has exact network_policy', () => { expect(d.network_policy).toEqual({ network_required: false }); });
    it('has exact data_egress_policy', () => { expect(d.data_egress_policy).toEqual({ egress: 'none' }); });
    it('has exact receipt_schema_ref', () => { expect(d.receipt_schema_ref).toBe('schemas/receipt.json'); });
    it('has exact verification_adapter', () => { expect(d.verification_adapter).toBe('read_back'); });
    it('has exact maturity', () => { expect(d.maturity).toBe('production_certified'); });
    it('has exact implementation_status', () => { expect(d.implementation_status).toBe('production_certified'); });
    it('has exact risk_feature_extractor', () => { expect(d.risk_feature_extractor).toBe('default'); });
  });

  describe('undo exact properties', () => {
    const d = get('undo');
    it('has exact effect_model', () => {
      expect(d.effect_model).toEqual({
        locality: 'local', operation: 'write', reversibility: 'guaranteed',
        data_egress: 'none', network_access: false, credential_access: false,
        blast_radius: 'workspace',
      });
    });
    it('has exact timeout_policy', () => { expect(d.timeout_policy).toEqual({ timeout_ms: 5000 }); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
  });

  describe('web_fetch exact properties', () => {
    const d = get('web_fetch');
    it('has exact effect_model', () => {
      expect(d.effect_model).toEqual({
        locality: 'remote', operation: 'read', reversibility: 'guaranteed',
        data_egress: 'metadata', network_access: true, credential_access: false,
        blast_radius: 'single_resource',
      });
    });
    it('has exact timeout_policy', () => { expect(d.timeout_policy).toEqual({ timeout_ms: 30000 }); });
    it('has exact retry_policy', () => { expect(d.retry_policy).toEqual({ max_retries: 2 }); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
    it('has exact network_policy', () => { expect(d.network_policy).toEqual({ network_required: true }); });
    it('has exact data_egress_policy', () => { expect(d.data_egress_policy).toEqual({ egress: 'metadata' }); });
    it('has exact maturity', () => { expect(d.maturity).toBe('sandbox_verified'); });
    it('has exact implementation_status', () => { expect(d.implementation_status).toBe('implemented'); });
    it('has exact domains', () => { expect(d.domains).toEqual(['research', 'coding']); });
  });

  describe('web_search exact properties', () => {
    const d = get('web_search');
    it('has exact effect_model', () => {
      expect(d.effect_model).toEqual({
        locality: 'remote', operation: 'read', reversibility: 'guaranteed',
        data_egress: 'metadata', network_access: true, credential_access: false,
        blast_radius: 'single_resource',
      });
    });
    it('has exact timeout_policy', () => { expect(d.timeout_policy).toEqual({ timeout_ms: 30000 }); });
    it('has exact retry_policy', () => { expect(d.retry_policy).toEqual({ max_retries: 2 }); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
    it('has exact network_policy', () => { expect(d.network_policy).toEqual({ network_required: true }); });
    it('has exact data_egress_policy', () => { expect(d.data_egress_policy).toEqual({ egress: 'metadata' }); });
    it('has exact maturity', () => { expect(d.maturity).toBe('sandbox_verified'); });
    it('has exact implementation_status', () => { expect(d.implementation_status).toBe('implemented'); });
    it('has exact domains', () => { expect(d.domains).toEqual(['research', 'coding']); });
  });

  describe('screenshot exact properties', () => {
    const d = get('screenshot');
    it('has exact effect_model', () => {
      expect(d.effect_model).toEqual({
        locality: 'local', operation: 'read', reversibility: 'guaranteed',
        data_egress: 'none', network_access: false, credential_access: false,
        blast_radius: 'single_resource',
      });
    });
    it('has exact timeout_policy', () => { expect(d.timeout_policy).toEqual({ timeout_ms: 10000 }); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
    it('has exact maturity', () => { expect(d.maturity).toBe('sandbox_verified'); });
    it('has exact implementation_status', () => { expect(d.implementation_status).toBe('implemented'); });
    it('has exact domains', () => { expect(d.domains).toEqual(['coding', 'documents', 'research']); });
    it('has display_policy', () => {
      expect(d.display_policy).toEqual({ surface_scope: 'desktop', screenshot_isolation: 'exclude_self_output' });
    });
  });

  describe('read_file exact properties', () => {
    const d = get('read_file');
    it('has exact effect_model', () => {
      expect(d.effect_model).toEqual({
        locality: 'local', operation: 'read', reversibility: 'guaranteed',
        data_egress: 'none', network_access: false, credential_access: false,
        blast_radius: 'single_resource',
      });
    });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
    it('has exact retry_policy', () => { expect(d.retry_policy).toEqual({ max_retries: 0 }); });
  });

  describe('write_file exact properties', () => {
    const d = get('write_file');
    it('has exact effect_model', () => {
      expect(d.effect_model.operation).toBe('write');
      expect(d.effect_model.reversibility).toBe('best_effort');
      expect(d.effect_model.data_egress).toBe('none');
      expect(d.effect_model.network_access).toBe(false);
      expect(d.effect_model.credential_access).toBe(false);
    });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
  });

  describe('edit_file exact properties', () => {
    const d = get('edit_file');
    it('has exact effect_model operation', () => { expect(d.effect_model.operation).toBe('write'); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: false }); });
  });

  describe('execute_command exact properties', () => {
    const d = get('execute_command');
    it('has exact effect_model', () => {
      expect(d.effect_model.operation).toBe('execute');
      expect(d.effect_model.locality).toBe('local');
      expect(d.effect_model.network_access).toBe(false);
    });
    it('has exact sandbox_policy', () => { expect(d.sandbox_policy).toEqual({ sandbox: true }); });
  });

  describe('list_directory exact properties', () => {
    const d = get('list_directory');
    it('has exact effect_model operation', () => { expect(d.effect_model.operation).toBe('read'); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
  });

  describe('search_files exact properties', () => {
    const d = get('search_files');
    it('has exact effect_model operation', () => { expect(d.effect_model.operation).toBe('read'); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
  });

  describe('create_artifact exact properties', () => {
    const d = get('create_artifact');
    it('has exact effect_model operation', () => { expect(d.effect_model.operation).toBe('create'); });
  });

  describe('parse_document exact properties', () => {
    const d = get('parse_document');
    it('has exact effect_model operation', () => { expect(d.effect_model.operation).toBe('read'); });
    it('has exact idempotency_policy', () => { expect(d.idempotency_policy).toEqual({ idempotent: true }); });
  });

  describe('ask_user exact properties', () => {
    const d = get('ask_user');
    it('has exact effect_model', () => {
      expect(d.effect_model.locality).toBe('local');
    });
  });

  describe('all tools common properties', () => {
    it('all have version 1.0.0', () => {
      for (const d of defs) expect(d.version).toBe('1.0.0');
    });
    it('all have receipt_schema_ref schemas/receipt.json', () => {
      for (const d of defs) expect(d.receipt_schema_ref).toBe('schemas/receipt.json');
    });
    it('all have verification_adapter read_back', () => {
      for (const d of defs) expect(d.verification_adapter).toBe('read_back');
    });
    it('all have risk_feature_extractor default', () => {
      for (const d of defs) expect(d.risk_feature_extractor).toBe('default');
    });
    it('all have cancellable true', () => {
      for (const d of defs) expect(d.cancellation_policy.cancellable).toBe(true);
    });
    it('all have credential_access false', () => {
      for (const d of defs) expect(d.effect_model.credential_access).toBe(false);
    });
    it('all have empty credential_requirements', () => {
      for (const d of defs) expect(d.credential_requirements).toEqual([]);
    });
    it('all have empty preconditions', () => {
      for (const d of defs) expect(d.preconditions).toEqual([]);
    });
    it('all have empty postconditions', () => {
      for (const d of defs) expect(d.postconditions).toEqual([]);
    });
  });
});
