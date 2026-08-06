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

  it('rejects mismatched method', () => {
    const actual: ApiContract = { endpoints: [{ method: 'GET', path: '/api/health', response_type: 'Health' }] };
    const expected: ApiContract = { endpoints: [{ method: 'POST', path: '/api/health', response_type: 'Health' }] };
    expect(validateContract(actual, expected)).toBe(false);
  });

  it('rejects mismatched path', () => {
    const actual: ApiContract = { endpoints: [{ method: 'GET', path: '/api/health', response_type: 'Health' }] };
    const expected: ApiContract = { endpoints: [{ method: 'GET', path: '/api/sessions', response_type: 'Health' }] };
    expect(validateContract(actual, expected)).toBe(false);
  });

  it('rejects different endpoint counts', () => {
    const actual: ApiContract = { endpoints: [{ method: 'GET', path: '/api/health', response_type: 'Health' }] };
    const expected: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/health', response_type: 'Health' },
      { method: 'GET', path: '/api/sessions', response_type: 'Session' },
    ] };
    expect(validateContract(actual, expected)).toBe(false);
  });

  it('accepts empty contracts', () => {
    const empty: ApiContract = { endpoints: [] };
    expect(validateContract(empty, empty)).toBe(true);
  });

  it('validates a full Phase 2 contract', () => {
    const contract: ApiContract = {
      endpoints: [
        { method: 'GET', path: '/api/health', response_type: 'HealthStatus' },
        { method: 'GET', path: '/api/sessions', response_type: 'Session[]' },
        { method: 'POST', path: '/api/sessions', response_type: 'Session' },
        { method: 'GET', path: '/api/documents', response_type: 'Document[]' },
        { method: 'POST', path: '/api/documents/ingest', response_type: 'Document' },
        { method: 'GET', path: '/api/rag/query', response_type: 'RagResult' },
      ],
    };
    expect(validateContract(contract, contract)).toBe(true);
  });
});
