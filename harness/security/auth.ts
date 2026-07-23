/**
 * AH-AUTH-001: Local Authentication Service
 *
 * Manages local authentication sessions with expiry and revocation.
 * WebAuthn/password boundaries are behind an adapter interface so tests
 * remain deterministic.
 *
 * Invariants:
 *  - Sessions expire after ttl_seconds
 *  - Logout immediately revokes the session
 *  - Revoked sessions cannot issue capabilities
 *  - Session IDs are unique UUIDs
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthSession {
  session_id: string;
  user_id: string;
  tenant_id: string;
  roles: string[];
  expires_at: string;
  created_at: string;
}

export interface AuthServiceOptions {
  sessionTtlSeconds?: number;
}

/**
 * Adapter for authentication methods (password, WebAuthn, etc.).
 * Tests use a deterministic stub; production uses real adapters.
 */
export interface AuthMethodAdapter {
  authenticate(credentials: unknown): { user_id: string; tenant_id: string; roles?: string[] } | null;
}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface SessionState {
  session: AuthSession;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Auth Service
// ---------------------------------------------------------------------------

const DEFAULT_TTL = 3600; // 1 hour

export class AuthService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionTtl: number;
  private methodAdapter: AuthMethodAdapter | null = null;

  constructor(opts: AuthServiceOptions = {}) {
    this.sessionTtl = opts.sessionTtlSeconds ?? DEFAULT_TTL;
  }

  setAuthMethodAdapter(adapter: AuthMethodAdapter): void {
    this.methodAdapter = adapter;
  }

  login(
    userId: string,
    tenantId: string,
    roles: string[] = ['agent'],
  ): AuthSession {
    const now = new Date();
    const session: AuthSession = {
      session_id: randomUUID(),
      user_id: userId,
      tenant_id: tenantId,
      roles: [...roles],
      expires_at: new Date(now.getTime() + this.sessionTtl * 1000).toISOString(),
      created_at: now.toISOString(),
    };

    this.sessions.set(session.session_id, {
      session,
      revoked: false,
    });

    return session;
  }

  loginWithCredentials(credentials: unknown): AuthSession | null {
    if (!this.methodAdapter) {
      throw new Error('No auth method adapter configured');
    }
    const result = this.methodAdapter.authenticate(credentials);
    if (!result) return null;
    return this.login(result.user_id, result.tenant_id, result.roles);
  }

  validateSession(sessionId: string): AuthSession | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    if (state.revoked) return null;

    const now = Date.now();
    const expires = new Date(state.session.expires_at).getTime();
    if (now > expires) return null;

    return state.session;
  }

  logout(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.revoked = true;
    }
  }

  canIssueCapability(sessionId: string): boolean {
    return this.validateSession(sessionId) !== null;
  }

  revokeAllForTenant(tenantId: string): void {
    for (const state of this.sessions.values()) {
      if (state.session.tenant_id === tenantId) {
        state.revoked = true;
      }
    }
  }

  get activeSessionCount(): number {
    let count = 0;
    for (const state of this.sessions.values()) {
      if (!state.revoked && this.validateSession(state.session.session_id)) {
        count++;
      }
    }
    return count;
  }
}
