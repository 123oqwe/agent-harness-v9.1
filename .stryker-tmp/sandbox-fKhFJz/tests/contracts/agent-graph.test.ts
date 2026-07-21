// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { validateFixture, loadFixture } from '../helpers/schema-validator';

describe('AH-CONTRACT-AGENTGRAPH: agent-graph schema', () => {
  it('valid fixture passes full schema validation', () => {
    const data = loadFixture('0', 'valid', 'agent-graph.json');
    const result = validateFixture('agent-graph.schema.json', data);
    expect(result.valid).toBe(true);
  });

  it('invalid fixture (missing nodes) fails schema validation', () => {
    const data = loadFixture('0', 'invalid', 'agent-graph.json');
    const result = validateFixture('agent-graph.schema.json', data);
    expect(result.valid).toBe(false);
  });

  // FG7/FG9: execution_mode enum validation.
  const baseValid = loadFixture('0', 'valid', 'agent-graph.json') as Record<string, unknown>;

  it('FG7/FG9: valid execution_mode passes', () => {
    const result = validateFixture('agent-graph.schema.json', {
      ...baseValid,
      execution_mode: 'routing_slip',
      routing_slip: { itinerary: [], executed: [], compensations: [], inserted_steps: 0, insert_limit: 3 },
    });
    expect(result.valid).toBe(true);
  });

  it('FG7/FG9: invalid execution_mode fails', () => {
    const result = validateFixture('agent-graph.schema.json', {
      ...baseValid,
      execution_mode: 'ad_hoc',
    });
    expect(result.valid).toBe(false);
  });

  it('FG8: valid message_security passes', () => {
    const result = validateFixture('agent-graph.schema.json', {
      ...baseValid,
      message_security: { obo_token_required: true, jws_signature_required: true, jwe_optional: true },
    });
    expect(result.valid).toBe(true);
  });
});
