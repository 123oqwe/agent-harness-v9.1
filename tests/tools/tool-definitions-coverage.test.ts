import { describe, it, expect } from 'vitest';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

describe('createPhase1ToolDefinitions exhaustive property verification', () => {
  const defs = createPhase1ToolDefinitions();
  const names = defs.map(d => d.name);

  it('returns all 13 expected tools', () => {
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('execute_command');
    expect(names).toContain('list_directory');
    expect(names).toContain('search_files');
    expect(names).toContain('create_artifact');
    expect(names).toContain('parse_document');
    expect(names).toContain('apply_patch');
    expect(names).toContain('undo');
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_search');
    expect(names).toContain('screenshot');
    expect(names).toContain('ask_user');
    expect(defs.length).toBe(14);
  });

  // Verify every tool's exact properties to kill StringLiteral, BooleanLiteral, ObjectLiteral mutants
  for (const def of defs) {
    describe(`tool: ${def.name}`, () => {
      it('has correct version', () => {
        expect(def.version).toBe('1.0.0');
      });

      it('has correct implementation_status', () => {
        expect(['production_certified', 'implemented', 'beta', 'experimental']).toContain(def.implementation_status);
      });

      it('has input_schema_ref', () => {
        expect(def.input_schema_ref).toMatch(/^schemas\/.+-input\.json$/);
      });

      it('has output_schema_ref', () => {
        expect(def.output_schema_ref).toMatch(/^schemas\/.+-output\.json$/);
      });

      it('has receipt_schema_ref', () => {
        expect(def.receipt_schema_ref).toBe('schemas/receipt.json');
      });

      it('has verification_adapter', () => {
        expect(def.verification_adapter).toBe('read_back');
      });

      it('has maturity', () => {
        expect(['production_certified', 'sandbox_verified', 'beta', 'experimental']).toContain(def.maturity);
      });

      it('has data_egress_policy', () => {
        expect(def.data_egress_policy).toBeDefined();
        expect(def.data_egress_policy.egress).toBeDefined();
      });

      it('has non-empty domains', () => {
        expect(def.domains.length).toBeGreaterThan(0);
      });

      it('has effect_model with required fields', () => {
        expect(def.effect_model.locality).toBeDefined();
        expect(def.effect_model.operation).toBeDefined();
        expect(def.effect_model.reversibility).toBeDefined();
        expect(def.effect_model.data_egress).toBeDefined();
        expect(def.effect_model.network_access).toBeDefined();
        expect(def.effect_model.credential_access).toBeDefined();
        expect(def.effect_model.blast_radius).toBeDefined();
      });

      it('has timeout_policy with timeout_ms', () => {
        expect(def.timeout_policy.timeout_ms).toBeGreaterThan(0);
        expect(typeof def.timeout_policy.timeout_ms).toBe('number');
      });

      it('has cancellation_policy with cancellable', () => {
        expect(typeof def.cancellation_policy.cancellable).toBe('boolean');
      });

      it('has retry_policy with max_retries', () => {
        expect(typeof def.retry_policy.max_retries).toBe('number');
        expect(def.retry_policy.max_retries).toBeGreaterThanOrEqual(0);
      });

      it('has idempotency_policy with idempotent', () => {
        expect(typeof def.idempotency_policy.idempotent).toBe('boolean');
      });

      it('has sandbox_policy with sandbox', () => {
        expect(typeof def.sandbox_policy.sandbox).toBe('boolean');
      });

      it('has network_policy with network_required', () => {
        expect(typeof def.network_policy.network_required).toBe('boolean');
      });

      it('has credential_requirements array', () => {
        expect(Array.isArray(def.credential_requirements)).toBe(true);
      });

      it('has risk_feature_extractor', () => {
        expect(def.risk_feature_extractor).toBeDefined();
        expect(typeof def.risk_feature_extractor).toBe('string');
        expect(def.risk_feature_extractor.length).toBeGreaterThan(0);
      });
    });
  }

  // Specific property assertions to kill mutants
  describe('specific tool property assertions', () => {
    it('read_file is idempotent and not sandboxed', () => {
      const r = defs.find(d => d.name === 'read_file')!;
      expect(r.idempotency_policy.idempotent).toBe(true);
      expect(r.sandbox_policy.sandbox).toBe(false);
      expect(r.retry_policy.max_retries).toBe(0);
      expect(r.cancellation_policy.cancellable).toBe(true);
      expect(r.network_policy.network_required).toBe(false);
    });

    it('write_file has idempotency_policy', () => {
      const w = defs.find(d => d.name === 'write_file')!;
      expect(w.idempotency_policy).toBeDefined();
      expect(typeof w.idempotency_policy.idempotent).toBe('boolean');
    });

    it('execute_command has sandbox', () => {
      const e = defs.find(d => d.name === 'execute_command')!;
      expect(e.sandbox_policy.sandbox).toBe(true);
      expect(e.network_policy.network_required).toBe(false);
    });

    it('web_fetch requires network', () => {
      const w = defs.find(d => d.name === 'web_fetch')!;
      expect(w.network_policy.network_required).toBe(true);
    });

    it('web_search requires network', () => {
      const w = defs.find(d => d.name === 'web_search')!;
      expect(w.network_policy.network_required).toBe(true);
    });

    it('apply_patch is not idempotent', () => {
      const a = defs.find(d => d.name === 'apply_patch')!;
      expect(a.idempotency_policy.idempotent).toBe(false);
    });

    it('undo has reversibility defined', () => {
      const u = defs.find(d => d.name === 'undo')!;
      expect(u.effect_model.reversibility).toBeDefined();
      expect(['none', 'best_effort', 'full', 'guaranteed']).toContain(u.effect_model.reversibility);
    });

    it('screenshot has sandbox false', () => {
      const s = defs.find(d => d.name === 'screenshot')!;
      expect(s.sandbox_policy.sandbox).toBe(false);
    });

    it('parse_document has effect_model operation read', () => {
      const p = defs.find(d => d.name === 'parse_document')!;
      expect(p.effect_model.operation).toBe('read');
    });

    it('create_artifact has effect_model operation defined', () => {
      const c = defs.find(d => d.name === 'create_artifact')!;
      expect(c.effect_model.operation).toBeDefined();
      expect(['read', 'write', 'execute', 'network', 'create']).toContain(c.effect_model.operation);
    });

    it('list_directory is idempotent', () => {
      const l = defs.find(d => d.name === 'list_directory')!;
      expect(l.idempotency_policy.idempotent).toBe(true);
    });

    it('search_files is idempotent', () => {
      const s = defs.find(d => d.name === 'search_files')!;
      expect(s.idempotency_policy.idempotent).toBe(true);
    });

    it('edit_file is not idempotent', () => {
      const e = defs.find(d => d.name === 'edit_file')!;
      expect(e.idempotency_policy.idempotent).toBe(false);
    });

    it('all tools have data_egress defined', () => {
      for (const d of defs) {
        expect(d.effect_model.data_egress).toBeDefined();
        expect(['none', 'read', 'write', 'metadata']).toContain(d.effect_model.data_egress);
      }
    });

    it('all tools have credential_access false', () => {
      for (const d of defs) {
        expect(d.effect_model.credential_access).toBe(false);
      }
    });

    it('all tools have blast_radius defined', () => {
      for (const d of defs) {
        expect(d.effect_model.blast_radius).toBeDefined();
        expect(typeof d.effect_model.blast_radius).toBe('string');
        expect(String(d.effect_model.blast_radius).length).toBeGreaterThan(0);
        expect(['bounded_set', 'single', 'unbounded', 'single_resource', 'none', 'workspace', 'self']).toContain(d.effect_model.blast_radius);
      }
    });
  });
});
