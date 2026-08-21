/**
 * AH-SUBAGENT-001: subagent lifecycle with Authorization Service signing.
 *
 * The parent creates a ChildTaskManifest; the Authorization Service evaluates
 * and signs the child capability — NOT the parent. The signed child binds
 * manifest_hash, parent_delegation_proof, budget_ceiling, tool_grants
 * (a subset), resource_grants, and delegation_depth.
 *
 * This module is the lifecycle layer on top of AuthorizationService.issueChild:
 *  - validates the ChildTaskManifest (shape, G-CC1 per-agent config, privacy),
 *  - applies disallowed_tool_refs (deny wins over tool_grant_refs),
 *  - enforces max concurrent subagents (default 6) and max delegation depth
 *    (configurable; the remaining depth allowance decrements each hop),
 *  - emits an isolation=worktree spawn directive,
 *  - signs cross-process delegation messages that carry an OBO token (FG8).
 *
 * The spawner holds no private key: every child capability is produced by the
 * Authorization Service, so a parent can never self-sign a child.
 */
import type { ChildCapabilityRequest } from '../contracts/index.js';
import { CapabilityDelegationError, CapabilityInvalidError, type SignedCapabilityToken } from './capability.js';
import { hashCapabilityGrant, type AuthorizationService, type CapabilityGrantSet, type CapabilityIssueRequest } from './authorization-service.js';

/** G-CC1 per-agent config, validated at manifest evaluation. */
export interface SubagentAgentConfig {
  isolation?: 'worktree' | 'none';
  hooks_ref?: string;
  memory_scope?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  disallowed_tool_refs?: string[];
}

/** Spec input: the manifest a parent creates for a subagent task. */
export interface ChildTaskManifest {
  node_id: string;
  manifest_hash: string;
  operation_id: string;
  attempt_id: string;
  /** The parent's signed capability (the spawner passes it to the service). */
  parent: SignedCapabilityToken;
  /** The parent's grant material, verified against the parent's signed hashes. */
  parent_grants: CapabilityGrantSet;
  /** Depth of the parent that created this manifest (root parent = 0). */
  parent_delegation_depth: number;
  /** Requested grants — must attenuate under the parent's grants. */
  tool_grants: string[];
  resource_grants: string[];
  budget_ceiling: Record<string, unknown>;
  agent_config: SubagentAgentConfig;
}

/** Spec output: the service-signed child capability plus its spawn directive. */
export interface SpawnedSubagent {
  capability: SignedCapabilityToken;
  /** The child's delegation depth (parent depth + 1). */
  delegation_depth: number;
  /** Effective grants after disallowed_tool_refs (deny wins). */
  effective_tool_grants: string[];
  spawn: {
    node_id: string;
    isolation: SubagentAgentConfig['isolation'];
    /** isolation=worktree -> the runtime creates a git worktree. */
    worktree: boolean;
    hooks_ref: SubagentAgentConfig['hooks_ref'];
    memory_scope: SubagentAgentConfig['memory_scope'];
    effort: SubagentAgentConfig['effort'];
  };
}

/** Cross-process subagent delegation message (FG8). */
export interface SubagentDelegationMessage {
  capability: SignedCapabilityToken;
  /** Originating user's token — the chain cannot exceed it (FG8). */
  obo_token: string;
  jws_signature: string;
  payload: {
    from: string;
    to: string;
    child_manifest_hash: string;
  };
}

export const DEFAULT_MAX_CONCURRENT = 6;
export const DEFAULT_MAX_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A child's delegation depth is one deeper than its parent. */
export function childDelegationDepth(manifest: ChildTaskManifest): number {
  return manifest.parent_delegation_depth + 1;
}

/** Remaining delegation allowance for a capability operating at `atDepth`. */
export function remainingDepth(maxDepth: number, atDepth: number): number {
  return maxDepth - atDepth;
}

/** G-CC1 per-agent config validation. */
export function validateAgentConfig(cfg: SubagentAgentConfig): string[] {
  const errors: string[] = [];
  if (cfg.isolation !== undefined && !['worktree', 'none'].includes(cfg.isolation)) {
    errors.push(`invalid isolation "${cfg.isolation}"`);
  }
  if (cfg.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(cfg.effort)) {
    errors.push(`invalid effort "${cfg.effort}"`);
  }
  for (const field of ['hooks_ref', 'memory_scope'] as const) {
    if (cfg[field] !== undefined && cfg[field].trim().length === 0) {
      errors.push(`${field} must be non-empty`);
    }
  }
  for (const tool of cfg.disallowed_tool_refs ?? []) {
    if (tool.trim().length === 0) errors.push('disallowed_tool_refs must be non-empty');
  }
  return errors;
}

/**
 * Privacy invariant: a subagent context must not leak the parent's private
 * conversation. Scopes that copy the whole parent conversation are rejected;
 * anything else (isolated, shared-selective, explicit refs) is bounded.
 */
export function validateContextPrivacy(cfg: SubagentAgentConfig): string[] {
  const scope = cfg.memory_scope;
  if (scope === undefined) return [];
  if (scope === 'inherit' || scope === 'parent_conversation' || scope.startsWith('inherit:')) {
    return [`memory_scope "${scope}" leaks parent private conversation`];
  }
  return [];
}

/** ChildTaskManifest validation; returns the full error list (empty = valid). */
export function validateChildTaskManifest(manifest: ChildTaskManifest): string[] {
  const errors: string[] = [];
  if (manifest.node_id.trim().length === 0) errors.push('node_id must be non-empty');
  if (!/^[0-9a-f]{64}$/u.test(manifest.manifest_hash)) {
    errors.push('manifest_hash must be a lowercase SHA-256 hash');
  }
  if (manifest.operation_id.trim().length === 0) errors.push('operation_id must be non-empty');
  if (manifest.attempt_id.trim().length === 0) errors.push('attempt_id must be non-empty');
  if (!Number.isSafeInteger(manifest.parent_delegation_depth) || manifest.parent_delegation_depth < 0) {
    errors.push('parent_delegation_depth must be a non-negative safe integer');
  }
  for (const field of ['tool_grants', 'resource_grants'] as const) {
    for (const entry of manifest[field]) {
      if (entry.trim().length === 0) errors.push(`${field} must be non-empty`);
    }
  }
  if (!isRecord(manifest.budget_ceiling)) errors.push('budget_ceiling must be a plain object');
  errors.push(...validateAgentConfig(manifest.agent_config));
  errors.push(...validateContextPrivacy(manifest.agent_config));
  return errors;
}

/** disallowed_tool_refs DENY WINS over tool_grant_refs. */
export function effectiveToolMask(manifest: ChildTaskManifest): string[] {
  const denied = new Set(manifest.agent_config.disallowed_tool_refs ?? []);
  return manifest.tool_grants.filter((tool) => !denied.has(tool));
}

/**
 * Subagent lifecycle. Holds no private key: the Authorization Service signs
 * every child capability, so a parent cannot self-sign (security invariant).
 */
export class SubagentSpawner {
  readonly #service: AuthorizationService;
  readonly #maxConcurrent: number;
  readonly #maxDepth: number;
  /** operation_id -> number of active (not yet released) subagents. */
  readonly #active = new Map<string, number>();

  constructor(options: {
    service: AuthorizationService;
    max_concurrent?: number;
    max_depth?: number;
  }) {
    const maxConcurrent = options.max_concurrent ?? DEFAULT_MAX_CONCURRENT;
    const maxDepth = options.max_depth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new CapabilityInvalidError('max_concurrent must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new CapabilityInvalidError('max_depth must be a positive safe integer');
    }
    this.#service = options.service;
    this.#maxConcurrent = maxConcurrent;
    this.#maxDepth = maxDepth;
  }

  maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  maxDepth(): number {
    return this.#maxDepth;
  }

  /** Active (unreleased) subagent count for an operation. */
  active(operation_id: string): number {
    return this.#active.get(operation_id) ?? 0;
  }

  /** Release a subagent, freeing a concurrent slot. */
  release(operation_id: string): void {
    const count = this.active(operation_id);
    if (count > 0) this.#active.set(operation_id, count - 1);
  }

  /**
   * Evaluate the manifest and, if valid, have the Authorization Service sign
   * the child capability. Rejects when the manifest is invalid, the requested
   * depth exceeds the max (remaining depth 0), or the operation already has
   * max_concurrent active subagents.
   */
  async spawn(manifest: ChildTaskManifest): Promise<SpawnedSubagent> {
    const errors = validateChildTaskManifest(manifest);
    if (errors.length > 0) {
      throw new CapabilityInvalidError(`invalid child task manifest: ${errors.join('; ')}`);
    }

    const depth = childDelegationDepth(manifest);
    if (depth > this.#maxDepth) {
      throw new CapabilityDelegationError(
        `delegation depth ${depth} exceeds max depth ${this.#maxDepth}`,
      );
    }
    if (this.active(manifest.operation_id) >= this.#maxConcurrent) {
      throw new CapabilityDelegationError(
        `max concurrent subagents (${this.#maxConcurrent}) reached for ${manifest.operation_id}`,
      );
    }

    // Deny wins: the child never receives a tool the manifest disallows, even
    // if it appears in tool_grants.
    const tools = effectiveToolMask(manifest);
    const childGrants: CapabilityGrantSet = {
      tools,
      resources: manifest.resource_grants,
      budget: manifest.budget_ceiling,
    };

    // The service (not the parent) signs the delegation proof and the child.
    const proof = await this.#service.authorizeDelegation({
      parent: manifest.parent,
      parent_grants: manifest.parent_grants,
      child_manifest_hash: manifest.manifest_hash,
      delegation_depth: depth,
    });

    const request: ChildCapabilityRequest = {
      child_manifest_hash: manifest.manifest_hash,
      parent_delegation_proof: proof,
      budget_ceiling: manifest.budget_ceiling,
      tool_grants: tools,
      resource_grants: manifest.resource_grants,
      delegation_depth: depth,
    };

    const parentClaims = manifest.parent.claims;
    const claims: CapabilityIssueRequest = {
      operation_id: manifest.operation_id,
      attempt_id: manifest.attempt_id,
      manifest_hash: manifest.manifest_hash,
      policy_decision_hash: parentClaims.policy_decision_hash,
      tool_effect_contract_hash: parentClaims.tool_effect_contract_hash,
      subject_workload: parentClaims.subject_workload,
      tenant_id: parentClaims.tenant_id,
      audience: parentClaims.audience,
      tool_grant_hash: hashCapabilityGrant(childGrants.tools),
      resource_grant_hash: hashCapabilityGrant(childGrants.resources),
      budget_ceiling_hash: hashCapabilityGrant(childGrants.budget),
      execution_epoch: parentClaims.execution_epoch,
      confirmation_key_thumbprint: parentClaims.confirmation_key_thumbprint,
      not_before: parentClaims.not_before,
      expires_at: parentClaims.expires_at,
    };

    const capability = await this.#service.issueChild({
      parent: manifest.parent,
      parent_grants: manifest.parent_grants,
      request,
      claims,
    });

    this.#active.set(manifest.operation_id, this.active(manifest.operation_id) + 1);

    return {
      capability,
      delegation_depth: depth,
      effective_tool_grants: tools,
      spawn: {
        node_id: manifest.node_id,
        isolation: manifest.agent_config.isolation,
        worktree: manifest.agent_config.isolation === 'worktree',
        hooks_ref: manifest.agent_config.hooks_ref,
        memory_scope: manifest.agent_config.memory_scope,
        effort: manifest.agent_config.effort,
      },
    };
  }
}

/**
 * Build a cross-process subagent delegation message (FG8): it always carries
 * the originating user's OBO token and a JWS signature over the payload, so
 * the chain cannot exceed the originating user's permissions and tampering is
 * detectable. The signer is provided by the caller (dependency-free module).
 */
export function createSubagentDelegation(options: {
  from: string;
  to: string;
  capability: SignedCapabilityToken;
  obo_token: string;
  sign: (payload: unknown) => string;
}): SubagentDelegationMessage {
  const payload = {
    from: options.from,
    to: options.to,
    child_manifest_hash: options.capability.claims.manifest_hash,
  };
  return {
    capability: options.capability,
    obo_token: options.obo_token,
    payload,
    jws_signature: options.sign(payload),
  };
}

/** Verify a delegation message: OBO token present, signature valid, bound. */
export function verifySubagentDelegation(
  message: SubagentDelegationMessage,
  verify: (payload: unknown, signature: string) => boolean,
): boolean {
  return (
    message.obo_token.length > 0 &&
    message.jws_signature.length > 0 &&
    message.payload.child_manifest_hash === message.capability.claims.manifest_hash &&
    verify(message.payload, message.jws_signature)
  );
}
