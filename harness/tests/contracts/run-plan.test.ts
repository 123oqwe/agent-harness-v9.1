import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFixture, loadFixture } from '../helpers/schema-validator';

describe('AH-CONTRACT-RUNPLAN-001: run-plan schema', () => {
  it('valid fixture passes full schema validation', () => {
    const data = loadFixture('0', 'valid', 'run-plan.json');
    const result = validateFixture('run-plan.schema.json', data);
    expect(result.valid).toBe(true);
  });

  it('invalid fixture fails schema validation', () => {
    const data = loadFixture('0', 'invalid', 'run-plan.json');
    const result = validateFixture('run-plan.schema.json', data);
    expect(result.valid).toBe(false);
  });

  // FG2/FG5/FG10/FG11: new optional fields validated when present.
  const baseValid = loadFixture('0', 'valid', 'run-plan.json') as Record<string, unknown>;

  it.each(['direct', 'react', 'plan_execute'])(
    'accepts the Phase 1 reasoning strategy %s',
    (reasoningStrategy) => {
      const result = validateFixture('run-plan.schema.json', {
        ...baseValid,
        reasoning_strategy: reasoningStrategy,
      });

      expect(result.valid).toBe(true);
    },
  );

  it('rejects a RunPlan without reasoning_strategy', () => {
    const { reasoning_strategy: _omitted, ...withoutReasoningStrategy } = baseValid;
    const result = validateFixture('run-plan.schema.json', withoutReasoningStrategy);

    expect(result.valid).toBe(false);
  });

  it('rejects an unsupported reasoning_strategy', () => {
    const result = validateFixture('run-plan.schema.json', {
      ...baseValid,
      reasoning_strategy: 'iterative_refinement',
    });

    expect(result.valid).toBe(false);
  });

  it('keeps the generated RunPlan type in parity with the strategy enum', () => {
    const generatedTypePath = fileURLToPath(
      new URL('../../../spec/types/run-plan.ts', import.meta.url),
    );
    const generatedType = readFileSync(generatedTypePath, 'utf8');

    expect(generatedType).toMatch(
      /reasoning_strategy:\s*"direct"\s*\|\s*"react"\s*\|\s*"plan_execute"/,
    );
  });

  it('FG2: valid run_phase passes', () => {
    const result = validateFixture('run-plan.schema.json', {
      ...baseValid,
      run_phase: { setup: { network: 'enabled' }, agent: { network: 'disabled', credentials_stripped: true } },
    });
    expect(result.valid).toBe(true);
  });

  it('FG5/FG11: valid context_strategy passes', () => {
    const result = validateFixture('run-plan.schema.json', {
      ...baseValid,
      context_strategy: { cache_breakpoints: ['system_prompt'], offload_token_threshold: 20000, summarize_at_window_ratio: 0.85, tool_masking: true, active_plan_injection: true },
    });
    expect(result.valid).toBe(true);
  });
});
