import { describe, expect, it } from 'vitest';
import { validateContract, type ApiContract } from '../../../packages/ui/src/index.js';

describe('AH-UX-CONTRACT-001: Frontend-backend contract tests', () => {
  it('validates matching contracts', () => {
    const contract: ApiContract = {
      endpoints: [
        { method: 'GET', path: '/api/health', response_type: 'HealthStatus' },
        { method: 'POST', path: '/api/sessions', response_type: 'Session' },
      ],
    };
    expect(validateContract(contract, contract)).toBe(true);
  });

  it('rejects mismatched contracts', () => {
    const actual: ApiContract = { endpoints: [{ method: 'GET', path: '/api/health', response_type: 'Health' }] };
    const expected: ApiContract = { endpoints: [{ method: 'POST', path: '/api/health', response_type: 'Health' }] };
    expect(validateContract(actual, expected)).toBe(false);
  });
});
