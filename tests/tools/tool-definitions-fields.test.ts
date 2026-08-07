import { describe, it, expect } from 'vitest';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

describe('Tool Definition Field Values', () => {
  const defs = createPhase1ToolDefinitions();
  const byName = (name: string) => defs.find(d => d.name === name)!;

  describe('read_file', () => {
    const d = byName('read_file');
    it('has correct effect_model', () => {
      expect(d.effect_model.locality).toBe('local');
      expect(d.effect_model.operation).toBe('read');
      expect(d.effect_model.reversibility).toBe('guaranteed');
      expect(d.effect_model.data_egress).toBe('none');
      expect(d.effect_model.network_access).toBe(false);
      expect(d.effect_model.credential_access).toBe(false);
      expect(d.effect_model.blast_radius).toBe('single_resource');
    });
    it('has correct policies', () => {
      expect(d.timeout_policy.timeout_ms).toBe(5000);
      expect(d.cancellation_policy.cancellable).toBe(true);
      expect(d.retry_policy.max_retries).toBeGreaterThanOrEqual(0);
      expect(d.idempotency_policy.idempotent).toBe(true);
      expect(d.sandbox_policy.sandbox).toBe(false);
      expect(d.network_policy.network_required).toBe(false);
    });
    it('has correct metadata', () => {
      expect(d.version).toBe('1.0.0');
      expect(d.domains).toContain('coding');
      expect(d.domains).toContain('documents');
      expect(d.domains).toContain('research');
      expect(d.implementation_status).toBe('production_certified');
      expect(d.risk_feature_extractor).toBe('default');
      expect(d.data_egress_policy.egress).toBe('none');
      expect(d.verification_adapter).toBe('read_back');
      expect(d.maturity).toBe('production_certified');
    });
  });

  describe('write_file', () => {
    const d = byName('write_file');
    it('has correct effect_model', () => {
      expect(d.effect_model.locality).toBe('local');
      expect(d.effect_model.operation).toBe('write');
      expect(d.effect_model.reversibility).toBe('best_effort');
      expect(d.effect_model.data_egress).toBe('none');
      expect(d.effect_model.network_access).toBe(false);
      expect(d.effect_model.blast_radius).toBe('single_resource');
    });
    it('has correct policies', () => {
      expect(d.idempotency_policy.idempotent).toBe(true);
      expect(d.sandbox_policy.sandbox).toBe(false);
      expect(d.timeout_policy.timeout_ms).toBe(5000);
    });
    it('has correct domains', () => {
      expect(d.domains).toContain('coding');
      expect(d.domains).toContain('writing');
    });
  });

  describe('edit_file', () => {
    const d = byName('edit_file');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('write');
      expect(d.effect_model.reversibility).toBe('best_effort');
      expect(d.effect_model.blast_radius).toBe('single_resource');
    });
    it('has correct policies', () => {
      expect(d.idempotency_policy.idempotent).toBe(false);
      expect(d.timeout_policy.timeout_ms).toBe(5000);
    });
  });

  describe('execute_command', () => {
    const d = byName('execute_command');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('execute');
      expect(d.effect_model.reversibility).toBe('none');
      expect(d.effect_model.blast_radius).toBe('workspace');
    });
    it('has correct policies', () => {
      expect(d.sandbox_policy.sandbox).toBe(true);
      expect(d.network_policy.network_required).toBe(false);
      expect(d.idempotency_policy.idempotent).toBe(false);
      expect(d.timeout_policy.timeout_ms).toBe(30000);
    });
  });

  describe('list_directory', () => {
    const d = byName('list_directory');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('read');
      expect(d.effect_model.reversibility).toBe('guaranteed');
    });
    it('has correct policies', () => {
      expect(d.idempotency_policy.idempotent).toBe(true);
      expect(d.timeout_policy.timeout_ms).toBe(5000);
    });
  });

  describe('search_files', () => {
    const d = byName('search_files');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('read');
      expect(d.effect_model.blast_radius).toBe('bounded_set');
    });
    it('has correct policies', () => {
      expect(d.idempotency_policy.idempotent).toBe(true);
      expect(d.timeout_policy.timeout_ms).toBe(10000);
    });
  });

  describe('apply_patch', () => {
    const d = byName('apply_patch');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('write');
      expect(d.effect_model.reversibility).toBe('best_effort');
      expect(d.effect_model.blast_radius).toBe('bounded_set');
    });
    it('has correct policies', () => {
      expect(d.idempotency_policy.idempotent).toBe(false);
      expect(d.timeout_policy.timeout_ms).toBe(10000);
    });
  });

  describe('undo', () => {
    const d = byName('undo');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('write');
      expect(d.effect_model.reversibility).toBe('guaranteed');
      expect(d.effect_model.blast_radius).toBe('workspace');
    });
    it('has correct policies', () => {
      expect(d.idempotency_policy.idempotent).toBe(true);
      expect(d.timeout_policy.timeout_ms).toBe(5000);
    });
  });

  describe('web_fetch', () => {
    const d = byName('web_fetch');
    it('has correct effect_model', () => {
      expect(d.effect_model.locality).toBe('remote');
      expect(d.effect_model.operation).toBe('read');
      expect(d.effect_model.network_access).toBe(true);
      expect(d.effect_model.data_egress).toBe('metadata');
    });
    it('has correct policies', () => {
      expect(d.sandbox_policy.sandbox).toBe(false);
      expect(d.network_policy.network_required).toBe(true);
      expect(d.idempotency_policy.idempotent).toBe(true);
      expect(d.timeout_policy.timeout_ms).toBe(30000);
    });
    it('has correct status', () => {
      expect(d.implementation_status).toBe('implemented');
      expect(d.maturity).toBe('sandbox_verified');
    });
  });

  describe('web_search', () => {
    const d = byName('web_search');
    it('has correct effect_model', () => {
      expect(d.effect_model.locality).toBe('remote');
      expect(d.effect_model.network_access).toBe(true);
      expect(d.effect_model.data_egress).toBe('metadata');
    });
    it('has correct policies', () => {
      expect(d.network_policy.network_required).toBe(true);
      expect(d.idempotency_policy.idempotent).toBe(true);
    });
  });

  describe('screenshot', () => {
    const d = byName('screenshot');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('read');
      expect(d.effect_model.locality).toBe('local');
    });
    it('has correct status', () => {
      expect(d.implementation_status).toBe('implemented');
      expect(d.maturity).toBe('sandbox_verified');
    });
  });

  describe('create_artifact', () => {
    const d = byName('create_artifact');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('create');
      expect(d.effect_model.reversibility).toBe('best_effort');
      expect(d.effect_model.blast_radius).toBe('single_resource');
    });
  });

  describe('ask_user', () => {
    const d = byName('ask_user');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('communicate');
      expect(d.effect_model.reversibility).toBe('guaranteed');
      expect(d.effect_model.blast_radius).toBe('self');
    });
    it('has correct policies', () => {
      expect(d.timeout_policy.timeout_ms).toBe(60000);
    });
  });

  describe('parse_document', () => {
    const d = byName('parse_document');
    it('has correct effect_model', () => {
      expect(d.effect_model.operation).toBe('read');
    });
    it('has correct policies', () => {
      expect(d.timeout_policy.timeout_ms).toBe(10000);
    });
  });

  describe('all tools consistency', () => {
    it('every tool has a non-empty name', () => {
      for (const d of defs) expect(d.name.length).toBeGreaterThan(0);
    });
    it('every tool has version 1.0.0', () => {
      for (const d of defs) expect(d.version).toBe('1.0.0');
    });
    it('every tool has at least one domain', () => {
      for (const d of defs) expect(d.domains.length).toBeGreaterThan(0);
    });
    it('every tool has a schema reference', () => {
      for (const d of defs) {
        expect(d.input_schema_ref.length).toBeGreaterThan(0);
        expect(d.output_schema_ref.length).toBeGreaterThan(0);
      }
    });
    it('every tool has risk_feature_extractor = default', () => {
      for (const d of defs) expect(d.risk_feature_extractor).toBe('default');
    });
    it('every tool has non-empty data_egress_policy', () => {
      for (const d of defs) expect(String(d.data_egress_policy.egress).length).toBeGreaterThan(0);
    });
    it('every tool has non-empty verification_adapter', () => {
      for (const d of defs) expect(d.verification_adapter.length).toBeGreaterThan(0);
    });
    it('every tool has non-empty receipt_schema_ref', () => {
      for (const d of defs) expect(d.receipt_schema_ref.length).toBeGreaterThan(0);
    });
    it('every tool has cancellation_policy', () => {
      for (const d of defs) expect(d.cancellation_policy).toBeDefined();
    });
    it('every tool has retry_policy with max_retries', () => {
      for (const d of defs) expect(d.retry_policy.max_retries).toBeGreaterThanOrEqual(0);
    });
  });
});
