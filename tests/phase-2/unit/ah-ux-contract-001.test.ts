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
  it('does not check response_type (only method and path)', () => {
    const actual: ApiContract = { endpoints: [{ method: 'GET', path: '/api/health', response_type: 'Health' }] };
    const expected: ApiContract = { endpoints: [{ method: 'GET', path: '/api/health', response_type: 'Status' }] };
    expect(validateContract(actual, expected)).toBe(true);
  });

  it('validates single endpoint contract', () => {
    const contract: ApiContract = { endpoints: [{ method: 'POST', path: '/api/test', response_type: 'TestResult' }] };
    expect(validateContract(contract, contract)).toBe(true);
  });


  it('accepts empty endpoints array', () => {
    const c: ApiContract = { endpoints: [] };
    expect(validateContract(c, c)).toBe(true);
  });
  it('handles multiple endpoints with same path different methods', () => {
    const c: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/items', response_type: 'Items' },
      { method: 'POST', path: '/api/items', response_type: 'Item' },
    ]};
    expect(validateContract(c, c)).toBe(true);
  });
  it('handles REST API contract', () => {
    const c: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/users', response_type: 'UserList' },
      { method: 'POST', path: '/api/users', response_type: 'User' },
      { method: 'GET', path: '/api/users/:id', response_type: 'User' },
      { method: 'PUT', path: '/api/users/:id', response_type: 'User' },
      { method: 'DELETE', path: '/api/users/:id', response_type: 'void' },
    ]};
    expect(validateContract(c, c)).toBe(true);
  });

  it('rejects extra endpoint in actual', () => {
    const actual: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/health', response_type: 'Health' },
      { method: 'POST', path: '/api/sessions', response_type: 'Session' },
    ]};
    const expected: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/health', response_type: 'Health' },
    ]};
    expect(validateContract(actual, expected)).toBe(false);
  });

  it('rejects missing endpoint in actual', () => {
    const actual: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/health', response_type: 'Health' },
    ]};
    const expected: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/health', response_type: 'Health' },
      { method: 'POST', path: '/api/sessions', response_type: 'Session' },
    ]};
    expect(validateContract(actual, expected)).toBe(false);
  });

  it('handles WebSocket endpoints', () => {
    const c: ApiContract = { endpoints: [
      { method: 'WS', path: '/ws/events', response_type: 'Event' },
    ]};
    expect(validateContract(c, c)).toBe(true);
  });


  it('accepts contract with single endpoint', () => {
    const c: ApiContract = { endpoints: [{ method: 'GET', path: '/api/ping', response_type: 'Pong' }] };
    expect(validateContract(c, c)).toBe(true);
  });

  it('handles PATCH method', () => {
    const c: ApiContract = { endpoints: [{ method: 'PATCH', path: '/api/users/:id', response_type: 'User' }] };
    expect(validateContract(c, c)).toBe(true);
  });

  it('handles HEAD method', () => {
    const c: ApiContract = { endpoints: [{ method: 'HEAD', path: '/api/health', response_type: 'void' }] };
    expect(validateContract(c, c)).toBe(true);
  });

  it('handles OPTIONS method', () => {
    const c: ApiContract = { endpoints: [{ method: 'OPTIONS', path: '/api/health', response_type: 'void' }] };
    expect(validateContract(c, c)).toBe(true);
  });

  it('rejects swapped actual and expected', () => {
    const actual: ApiContract = { endpoints: [{ method: 'GET', path: '/api/a', response_type: 'A' }] };
    const expected: ApiContract = { endpoints: [{ method: 'GET', path: '/api/b', response_type: 'B' }] };
    expect(validateContract(actual, expected)).toBe(false);
    expect(validateContract(expected, actual)).toBe(false);
  });


  it('handles contract with many endpoints', () => {
    const endpoints = [];
    for (let i = 0; i < 20; i++) {
      endpoints.push({ method: 'GET', path: '/api/resource/' + i, response_type: 'Resource' });
    }
    const c: ApiContract = { endpoints };
    expect(validateContract(c, c)).toBe(true);
  });

  it('handles contract with DELETE method', () => {
    const c: ApiContract = { endpoints: [{ method: 'DELETE', path: '/api/items/:id', response_type: 'void' }] };
    expect(validateContract(c, c)).toBe(true);
  });

  it('self-comparison always returns true', () => {
    const c: ApiContract = { endpoints: [
      { method: 'GET', path: '/api/a', response_type: 'A' },
      { method: 'POST', path: '/api/b', response_type: 'B' },
    ]};
    expect(validateContract(c, c)).toBe(true);
  });

});
