import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from '../../security/auth.js';

describe('AH-AUTH-001: local authentication', () => {
  let auth: AuthService;

  beforeEach(() => {
    auth = new AuthService({ sessionTtlSeconds: 60 });
  });

  it('creates a session for a valid subject', () => {
    const session = auth.login('user-001', 'tenant-001');
    expect(session.session_id).toBeTruthy();
    expect(session.user_id).toBe('user-001');
    expect(session.tenant_id).toBe('tenant-001');
    expect(session.expires_at).toBeTruthy();
  });

  it('session IDs are unique', () => {
    const s1 = auth.login('user-001', 'tenant-001');
    const s2 = auth.login('user-001', 'tenant-001');
    expect(s1.session_id).not.toBe(s2.session_id);
  });

  it('validates an active session', () => {
    const session = auth.login('user-001', 'tenant-001');
    const validated = auth.validateSession(session.session_id);
    expect(validated).not.toBeNull();
    expect(validated!.user_id).toBe('user-001');
  });

  it('rejects unknown session ID', () => {
    expect(auth.validateSession('nonexistent')).toBeNull();
  });

  it('rejects expired session', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const session = auth.login('user-001', 'tenant-001');
    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    expect(auth.validateSession(session.session_id)).toBeNull();
    vi.useRealTimers();
  });

  it('logout revokes the session', () => {
    const session = auth.login('user-001', 'tenant-001');
    auth.logout(session.session_id);
    expect(auth.validateSession(session.session_id)).toBeNull();
  });

  it('revoking a session prevents new capability issuance', () => {
    const session = auth.login('user-001', 'tenant-001');
    auth.logout(session.session_id);
    expect(auth.canIssueCapability(session.session_id)).toBe(false);
  });

  it('active session can issue capability', () => {
    const session = auth.login('user-001', 'tenant-001');
    expect(auth.canIssueCapability(session.session_id)).toBe(true);
  });

  it('session includes roles', () => {
    const session = auth.login('user-001', 'tenant-001', ['agent']);
    expect(session.roles).toContain('agent');
  });

  it('default role is "agent"', () => {
    const session = auth.login('user-001', 'tenant-001');
    expect(session.roles).toEqual(['agent']);
  });

  it('revokeAllForTenant revokes all sessions in tenant', () => {
    const s1 = auth.login('user-001', 'tenant-001');
    const s2 = auth.login('user-002', 'tenant-001');
    const s3 = auth.login('user-003', 'tenant-002');
    auth.revokeAllForTenant('tenant-001');
    expect(auth.validateSession(s1.session_id)).toBeNull();
    expect(auth.validateSession(s2.session_id)).toBeNull();
    expect(auth.validateSession(s3.session_id)).not.toBeNull();
  });
});
