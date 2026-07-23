import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthorizationService,
  type AuthzSubject,
  type AuthzResource,
  type AuthzRequest,
} from '../../security/authorization-service.js';

function subject(overrides: Partial<AuthzSubject> = {}): AuthzSubject {
  return {
    user_id: 'user-001',
    tenant_id: 'tenant-001',
    roles: ['agent'],
    session_id: 'session-001',
    ...overrides,
  };
}

function resource(overrides: Partial<AuthzResource> = {}): AuthzResource {
  return {
    type: 'file',
    id: '/workspace/readme.md',
    owner: 'user-001',
    tenant_id: 'tenant-001',
    ...overrides,
  };
}

function request(overrides: Partial<AuthzRequest> = {}): AuthzRequest {
  return {
    subject: subject(),
    resource: resource(),
    effect: 'read',
    run_id: 'run-001',
    step_id: 'step-001',
    attempt_id: 'attempt-001',
    ...overrides,
  };
}

describe('AH-AUTHZ-001: authorization service', () => {
  let svc: AuthorizationService;

  beforeEach(() => {
    svc = new AuthorizationService();
  });

  it('allows owner to read own resource', () => {
    const result = svc.authorize(request());
    expect(result.allowed).toBe(true);
  });

  it('denies non-owner read when no explicit grant', () => {
    const result = svc.authorize(request({
      subject: subject({ user_id: 'other-user' }),
    }));
    expect(result.allowed).toBe(false);
  });

  it('denies cross-tenant access', () => {
    const result = svc.authorize(request({
      subject: subject({ tenant_id: 'other-tenant' }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('tenant mismatch');
  });

  it('denies write to read-only resource', () => {
    svc.registerResourcePolicy(resource().type, { allowed_effects: ['read'] });
    const result = svc.authorize(request({ effect: 'write' }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('not allowed'))).toBe(true);
  });

  it('admin role can access any resource in tenant', () => {
    svc.registerRolePolicy('admin', { wildcard_access: true });
    const result = svc.authorize(request({
      subject: subject({ user_id: 'other-user', roles: ['admin'] }),
    }));
    expect(result.allowed).toBe(true);
  });

  it('explicit deny rule overrides allow', () => {
    svc.grant(subject().user_id, resource().id, 'read');
    svc.deny(subject().user_id, resource().id, 'read');
    const result = svc.authorize(request());
    expect(result.allowed).toBe(false);
  });

  it('explicit allow grant for non-owner works', () => {
    svc.grant('other-user', resource().id, 'read');
    const result = svc.authorize(request({
      subject: subject({ user_id: 'other-user' }),
    }));
    expect(result.allowed).toBe(true);
  });

  it('decision includes subject, resource, effect binding', () => {
    const result = svc.authorize(request());
    expect(result.subject_id).toBe('user-001');
    expect(result.resource_id).toBe('/workspace/readme.md');
    expect(result.effect).toBe('read');
    expect(result.run_id).toBe('run-001');
    expect(result.step_id).toBe('step-001');
    expect(result.attempt_id).toBe('attempt-001');
  });

  it('unknown effect is denied', () => {
    const result = svc.authorize(request({ effect: 'teleport' as 'read' }));
    expect(result.allowed).toBe(false);
  });

  it('empty subject roles denies by default', () => {
    const result = svc.authorize(request({
      subject: subject({ user_id: 'other-user', roles: [] }),
    }));
    expect(result.allowed).toBe(false);
  });

  it('revoking a grant removes access', () => {
    svc.grant('other-user', resource().id, 'read');
    svc.revokeGrant('other-user', resource().id, 'read');
    const result = svc.authorize(request({
      subject: subject({ user_id: 'other-user' }),
    }));
    expect(result.allowed).toBe(false);
  });
});
