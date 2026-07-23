/**
 * AH-AUTHZ-001: Authorization Service
 *
 * Subject/resource/effect authorization with deny-by-default. Issues
 * capability tokens via the CapabilityService, but does not override
 * Policy or Consent decisions.
 *
 * Invariants:
 *  - Default deny: unknown subject, resource, or effect is denied
 *  - Cross-tenant access is denied
 *  - Explicit deny rules override allow grants
 *  - Admin role grants wildcard access within tenant
 *  - Every decision is bound to run_id, step_id, attempt_id
 */

import { CapabilityService } from './capability.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthzEffect = 'read' | 'write' | 'execute' | 'delete';

export interface AuthzSubject {
  user_id: string;
  tenant_id: string;
  roles: string[];
  session_id: string;
}

export interface AuthzResource {
  type: string;
  id: string;
  owner: string;
  tenant_id: string;
}

export interface AuthzRequest {
  subject: AuthzSubject;
  resource: AuthzResource;
  effect: AuthzEffect;
  run_id: string;
  step_id: string;
  attempt_id: string;
}

export interface AuthzDecision {
  allowed: boolean;
  reasons: string[];
  subject_id: string;
  resource_id: string;
  effect: AuthzEffect;
  run_id: string;
  step_id: string;
  attempt_id: string;
  decided_at: string;
}

interface ResourcePolicy {
  allowed_effects: AuthzEffect[];
}

interface RolePolicy {
  wildcard_access: boolean;
}

// ---------------------------------------------------------------------------
// Authorization Service
// ---------------------------------------------------------------------------

const VALID_EFFECTS: AuthzEffect[] = ['read', 'write', 'execute', 'delete'];

export class AuthorizationService {
  private readonly resourcePolicies = new Map<string, ResourcePolicy>();
  private readonly rolePolicies = new Map<string, RolePolicy>();
  private readonly grants = new Map<string, boolean>();
  private readonly denies = new Map<string, boolean>();
  private readonly capabilityService: CapabilityService;

  constructor(capabilityService?: CapabilityService) {
    this.capabilityService = capabilityService ?? new CapabilityService();
  }

  authorize(req: AuthzRequest): AuthzDecision {
    const now = new Date().toISOString();

    // Validate effect
    if (!VALID_EFFECTS.includes(req.effect)) {
      return this.makeDeny(req, ['unknown effect: ' + req.effect], now);
    }

    // Cross-tenant check
    if (req.subject.tenant_id !== req.resource.tenant_id) {
      return this.makeDeny(req, ['tenant mismatch'], now);
    }

    // Check explicit deny first (deny overrides allow)
    const denyKey = this.grantKey(req.subject.user_id, req.resource.id, req.effect);
    if (this.denies.has(denyKey)) {
      return this.makeDeny(req, ['explicit deny rule'], now);
    }

    // Check resource policy (allowed effects)
    const resourcePolicy = this.resourcePolicies.get(req.resource.type);
    if (resourcePolicy && !resourcePolicy.allowed_effects.includes(req.effect)) {
      return this.makeDeny(req, [`effect '${req.effect}' not allowed for resource type '${req.resource.type}'`], now);
    }

    // Check wildcard role (admin)
    for (const role of req.subject.roles) {
      const rolePolicy = this.rolePolicies.get(role);
      if (rolePolicy?.wildcard_access) {
        return this.makeAllow(req, [`role '${role}' has wildcard access`], now);
      }
    }

    // Owner can access own resources
    if (req.subject.user_id === req.resource.owner) {
      return this.makeAllow(req, ['subject is resource owner'], now);
    }

    // Check explicit grants
    if (this.grants.has(denyKey)) {
      return this.makeAllow(req, ['explicit grant'], now);
    }

    // Default deny
    return this.makeDeny(req, ['no matching allow rule (deny by default)'], now);
  }

  registerResourcePolicy(resourceType: string, policy: ResourcePolicy): void {
    this.resourcePolicies.set(resourceType, { ...policy });
  }

  registerRolePolicy(role: string, policy: RolePolicy): void {
    this.rolePolicies.set(role, { ...policy });
  }

  grant(userId: string, resourceId: string, effect: AuthzEffect): void {
    const key = this.grantKey(userId, resourceId, effect);
    this.grants.set(key, true);
    // Remove any existing deny
    this.denies.delete(key);
  }

  deny(userId: string, resourceId: string, effect: AuthzEffect): void {
    const key = this.grantKey(userId, resourceId, effect);
    this.denies.set(key, true);
  }

  revokeGrant(userId: string, resourceId: string, effect: AuthzEffect): void {
    const key = this.grantKey(userId, resourceId, effect);
    this.grants.delete(key);
  }

  getCapabilityService(): CapabilityService {
    return this.capabilityService;
  }

  private makeAllow(req: AuthzRequest, reasons: string[], now: string): AuthzDecision {
    return {
      allowed: true,
      reasons,
      subject_id: req.subject.user_id,
      resource_id: req.resource.id,
      effect: req.effect,
      run_id: req.run_id,
      step_id: req.step_id,
      attempt_id: req.attempt_id,
      decided_at: now,
    };
  }

  private makeDeny(req: AuthzRequest, reasons: string[], now: string): AuthzDecision {
    return {
      allowed: false,
      reasons,
      subject_id: req.subject.user_id,
      resource_id: req.resource.id,
      effect: req.effect,
      run_id: req.run_id,
      step_id: req.step_id,
      attempt_id: req.attempt_id,
      decided_at: now,
    };
  }

  private grantKey(userId: string, resourceId: string, effect: AuthzEffect): string {
    return `${userId}:${resourceId}:${effect}`;
  }
}
