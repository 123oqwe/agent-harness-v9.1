import { describe, it, expect } from 'vitest';
import { validateFixture, loadFixture } from '../helpers/schema-validator';
import type { ToolSpec } from '../../../spec/types/tool-spec';

describe('AH-CONTRACT-TOOLSPEC-001: tool-spec schema', () => {
  it('valid fixture passes full schema validation', () => {
    const data = loadFixture('0', 'valid', 'tool-spec.json');
    const result = validateFixture('tool-spec.schema.json', data);
    expect(result.valid).toBe(true);
  });

  it('invalid fixture fails schema validation', () => {
    const data = loadFixture('0', 'invalid', 'tool-spec.json');
    const result = validateFixture('tool-spec.schema.json', data);
    expect(result.valid).toBe(false);
  });

  // FG1/FG2/FG3: new optional fields validated when present.
  const baseValid = loadFixture('0', 'valid', 'tool-spec.json') as ToolSpec;

  it('FG1: valid display_policy passes', () => {
    const result = validateFixture('tool-spec.schema.json', {
      ...baseValid,
      display_policy: { surface_scope: 'native_app_approved', approved_apps: ['com.apple.Terminal'], screenshot_isolation: 'exclude_self_output', global_interrupt_consumed: true, single_session_lock: true },
    });
    expect(result.valid).toBe(true);
  });

  it('FG1: display_policy with invalid screenshot_isolation fails', () => {
    const result = validateFixture('tool-spec.schema.json', {
      ...baseValid,
      display_policy: { screenshot_isolation: 'include_everything' },
    });
    expect(result.valid).toBe(false);
  });

  it('FG2: valid run_phase_binding passes', () => {
    const result = validateFixture('tool-spec.schema.json', {
      ...baseValid,
      run_phase_binding: ['setup', 'agent'],
    });
    expect(result.valid).toBe(true);
  });

  it('FG2: run_phase_binding with invalid phase value fails', () => {
    const result = validateFixture('tool-spec.schema.json', {
      ...baseValid,
      run_phase_binding: ['setup', 'production'],
    });
    expect(result.valid).toBe(false);
  });

  it('FG1: display_policy rejects unknown fields', () => {
    const result = validateFixture('tool-spec.schema.json', {
      ...baseValid,
      display_policy: { surface_scope: 'desktop', evil_field: 'x' },
    });
    expect(result.valid).toBe(false);
  });
});
