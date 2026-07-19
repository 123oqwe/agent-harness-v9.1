import { describe, it, expect } from 'vitest';
import { validateFixture, loadFixture } from '../helpers/schema-validator';
import type { EffectRisk } from '../../../spec/types/effect-risk';

describe('AH-CONTRACT-EFFECTRISK-001: effect-risk schema', () => {
  it('valid fixture passes full schema validation', () => {
    const data = loadFixture('0', 'valid', 'effect-risk.json');
    const result = validateFixture('effect-risk.schema.json', data);
    expect(result.valid).toBe(true);
  });

  it('invalid fixture fails schema validation', () => {
    const data = loadFixture('0', 'invalid', 'effect-risk.json');
    const result = validateFixture('effect-risk.schema.json', data);
    expect(result.valid).toBe(false);
  });

  // FG1/FG3: egress_policy and screen_access are optional but when present must conform.
  const baseValid: EffectRisk = {
    locality: 'local', operation: 'read', reversibility: 'guaranteed', data_egress: 'none',
    network_access: true, credential_access: true, blast_radius: 'single_resource',
    financial_impact_usd_micros: '0', human_impact: 'none', external_visibility: 'private',
    regulatory_sensitivity: [],
  };

  it('FG3: valid egress_policy passes', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
      egress_policy: { mode: 'allowlist', domain_rules: [{ action: 'allow', host: 'example.com' }, { action: 'deny', host: '*.evil.com' }], unix_sockets: 'denied', allow_local_binding: false, socks5: true },
    });
    expect(result.valid).toBe(true);
  });

  it('FG3: egress_policy with invalid action fails', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
      egress_policy: { mode: 'allowlist', domain_rules: [{ action: 'maybe', host: 'x.com' }] },
    });
    expect(result.valid).toBe(false);
  });

  it('FG3: egress_policy domain_rule missing host fails', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
      egress_policy: { mode: 'allowlist', domain_rules: [{ action: 'allow' }] },
    });
    expect(result.valid).toBe(false);
  });

  it('FG1: valid screen_access passes', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
      screen_access: { surface: 'native_app', input_modes: ['screenshot', 'click'], app_scope: 'per_app_approved' },
    });
    expect(result.valid).toBe(true);
  });

  it('FG1: screen_access with invalid surface fails', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
      screen_access: { surface: 'telepathy', input_modes: ['click'] },
    });
    expect(result.valid).toBe(false);
  });

  // Tightened: sub-objects reject unknown fields (additionalProperties: false).
  it('FG3: egress_policy rejects unknown fields', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
      egress_policy: { mode: 'allowlist', evil_field: 'x' },
    });
    expect(result.valid).toBe(false);
  });

  it('FG1: screen_access rejects unknown fields', () => {
    const result = validateFixture('effect-risk.schema.json', {
      ...baseValid,
 screen_access: { surface: 'browser', evil_field: 'x' },
    });
    expect(result.valid).toBe(false);
  });
});
