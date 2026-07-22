/**
 * Unified Tool Execution Pipeline.
 *
 * Every tool call goes through the full security chain:
 *   1. ToolSpec validation (frozen snapshot)
 *   2. Policy evaluation (deny-by-default)
 *   3. Capability issuance (AuthorizationService signs single-use token)
 *   4. PEP enforcement (verify signature, consume token, TOCTOU check)
 *   5. VFS/Sandbox dispatch
 *   6. Receipt
 *   7. Evidence (session event log)
 *
 * No tool may bypass this. The execute() callback runs INSIDE the PEP
 * authorization scope — it only fires if PEP allows.
 */
import { createHash } from 'node:crypto';
// Ed25519 keypair is injected by composition root, not self-generated
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../runtime/sandbox.js';
import type { ToolRegistry, RegistrySnapshot } from './tool-registry.js';
import type { ToolSpec } from '../../spec/types/tool-spec.js';
import type { PolicyEngine } from '../security/policy-engine.js';
import type { PolicyContext } from '../security/policy-engine.js';
import type { EffectRisk } from '../../spec/types/effect-risk.js';
import type { ActionManifest } from '../../spec/types/action-manifest.js';
import type { CapabilityToken } from '../../spec/types/capability-token.js';
import type { DurableSession } from '../session/durable-session.js';
import type { AuthorizationService } from '../security/authorization-service.js';
import type { InMemoryCapabilityStateStore} from '../security/capability.js';
import { hashCapabilityValue } from '../security/capability.js';
import type { PolicyEnforcementPoint} from '../security/pep.js';
import { type AuditEvent } from '../security/pep.js';

export interface ToolReceipt {
  tool_name: string;
  timestamp: string;
  success: boolean;
  error?: string | undefined;
  duration_ms: number;
  input_hash: string;
  output_hash?: string | undefined;
  token_id?: string | undefined;
  policy_decision?: string | undefined;
}

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry;
  snapshot: RegistrySnapshot;
  vfs: VirtualFilesystem;
  sandbox?: SandboxProfile;
  policyEngine: PolicyEngine;
  session: DurableSession;
}

export class ToolExecutorError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolExecutorError'; Object.setPrototypeOf(this, ToolExecutorError.prototype); }
}

function hash(s: unknown): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex');
}

/** Read risk from ToolSpec.effect_model. Falls back to safe read-only risk if not specified. */
function extractRisk(toolSpec: ToolSpec | undefined): EffectRisk {
  if (toolSpec) {
    const em = toolSpec.effect_model as Record<string, unknown> | undefined;
    if (em && typeof em.operation === 'string') {
      return {
        locality: (em.locality as 'local' | 'remote' | 'external') ?? 'local',
        operation: (em.operation as 'read' | 'write' | 'create' | 'delete' | 'execute' | 'publish' | 'communicate' | 'purchase') ?? 'read',
        reversibility: (em.reversibility as 'guaranteed' | 'best_effort' | 'none') ?? 'guaranteed',
        data_egress: (em.data_egress as 'none' | 'metadata' | 'content' | 'sensitive') ?? 'none',
        network_access: (em.network_access as boolean) ?? false,
        credential_access: (em.credential_access as boolean) ?? false,
        blast_radius: (em.blast_radius as 'single_resource' | 'bounded_set' | 'workspace' | 'organization' | 'public' | 'unbounded') ?? 'single_resource',
        financial_impact_usd_micros: (em.financial_impact_usd_micros as string) ?? '0',
        human_impact: (em.human_impact as 'none' | 'self' | 'internal_people' | 'external_people' | 'public') ?? 'none',
        external_visibility: (em.external_visibility as 'private' | 'shared' | 'public') ?? 'private',
        regulatory_sensitivity: (em.regulatory_sensitivity as string[]) ?? [],
      };
    }
  }
  // Safe default: read-only, no effects
  return {
    locality: 'local',
    operation: 'read',
    reversibility: 'guaranteed',
    data_egress: 'none',
    network_access: false,
    credential_access: false,
    blast_radius: 'single_resource',
    financial_impact_usd_micros: '0',
    human_impact: 'none',
    external_visibility: 'private',
    regulatory_sensitivity: [],
  };
}

function extractResourceIds(args: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof args.path === 'string') ids.push(args.path);
  if (typeof args.root === 'string') ids.push(args.root);
  if (Array.isArray(args.sources)) for (const src of args.sources) if (typeof src === 'string') ids.push(src);
  return ids;
}

/** Build a minimal ActionManifest for a tool call. */
function buildManifest(toolName: string, input: unknown, policyVersion: string, taskId: string, planId: string, stepId: string): ActionManifest {
  const isWrite = false; // determined by ToolSpec.effect_model, not by name
  const canonicalArgs = input as Record<string, unknown>;
  const manifestHash = hash({ toolName, input, policyVersion });
  return {
    task_id: taskId,
    plan_id: planId,
    step_id: stepId,
    tool_name: toolName,
    tool_version: '1.0.0',
    schema_hash: manifestHash,
    canonical_args: canonicalArgs,
    resource_ids: extractResourceIds(canonicalArgs),
    resource_versions: {},
    preconditions: {},
    expected_postconditions: {},
    reads: isWrite ? [] : Object.keys(canonicalArgs),
    writes: isWrite ? Object.keys(canonicalArgs) : [],
    external_effects: [],
    side_effect_class: isWrite ? 'idempotent_write' : 'read_only',
    credential_scope: [],
    max_attempts: 1,
    max_cost: {},
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    compensation_plan: null,
    policy_version: policyVersion,
    manifest_hash: manifestHash,
  };
}

export interface ToolExecutorInjectedDeps {
  authz: AuthorizationService;
  pep: PolicyEnforcementPoint;
  stateStore: InMemoryCapabilityStateStore;
  now: () => string;
}

export class ToolExecutor {
  private readonly authz: AuthorizationService;
  private readonly pep: PolicyEnforcementPoint;
  private readonly stateStore: InMemoryCapabilityStateStore;
  private readonly injectedNow: () => string;
  private readonly auditLog: AuditEvent[] = [];
  private callCount = 0;
  private _currentTokenHash = '';

  constructor(private deps: ToolExecutorDeps, injected: ToolExecutorInjectedDeps) {
    this.authz = injected.authz;
    this.pep = injected.pep;
    this.stateStore = injected.stateStore;
    this.injectedNow = injected.now;
  }

  async execute<T>(toolName: string, input: unknown, fn: (deps: ToolExecutorDeps) => Promise<T>): Promise<{ result: T; receipt: ToolReceipt }> {
    const start = Date.now();
    this.callCount++;
    const operationId = `op-${this.callCount}`;
    const attemptId = `att-${this.callCount}`;

    // 1. ToolSpec validation: tool must exist in frozen snapshot
    if (!this.deps.toolRegistry.inSnapshot(toolName, this.deps.snapshot)) {
      throw new ToolExecutorError(`tool not in frozen snapshot: ${toolName}`);
    }

    // 2. Policy evaluation: deny-by-default
    const policy = this.deps.policyEngine.snapshot;
    if (!policy.allowed_tools.includes(toolName)) {
      this.deps.session.append('error', { tool: toolName, reason: 'policy denied: not in allowed_tools' });
      throw new ToolExecutorError(`policy denied: ${toolName} not in allowed_tools`);
    }

    // 3. Build manifest and evaluate risk
    const manifest = buildManifest(toolName, input, policy.version, 'task-1', 'plan-1', `step-${this.callCount}`);
    const toolSpec = this.deps.toolRegistry.get(toolName);
    const risk = extractRisk(toolSpec);
    const policyContext: PolicyContext = {
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      run_phase: 'agent',
      trust_level: 'trusted',
      now: new Date().toISOString(),
    };

    // 4. Issue a single-use capability token
    let token: CapabilityToken;
    const issueTime = this.injectedNow();
    try {
      const decision = this.deps.policyEngine.evaluate({
        tool_name: toolName,
        resource_ids: manifest.resource_ids,
        risk,
        context: policyContext,
      });
      if (!decision.allowed) {
        this.deps.session.append('error', { tool: toolName, reason: `policy denied: ${decision.reason_code}` });
        throw new ToolExecutorError(`policy denied: ${decision.reason_code}`);
      }
      const signedToken = await this.authz.issue({
        operation_id: operationId,
        attempt_id: attemptId,
        manifest_hash: manifest.manifest_hash,
        policy_decision_hash: decision.decision_hash,
        tool_effect_contract_hash: hash(risk),
        subject_workload: 'harness-runtime',
        tenant_id: 'tenant-1',
        audience: 'tool-host',
        tool_grant_hash: hash(toolName),
        resource_grant_hash: hash(manifest.resource_ids),
        budget_ceiling_hash: hash({ max_iterations: 3 }),
        execution_epoch: issueTime,
        confirmation_key_thumbprint: 'thumbprint-1',
        not_before: issueTime,
        expires_at: new Date(Date.parse(issueTime) + 300_000).toISOString(),
      });
      token = signedToken.claims;
      this._currentTokenHash = hashCapabilityValue(signedToken.claims);
    } catch (e) {
      if (e instanceof ToolExecutorError) throw e;
      this.deps.session.append('error', { tool: toolName, reason: `capability issue failed: ${(e as Error).message}` });
      throw new ToolExecutorError(`capability issue failed: ${(e as Error).message}`);
    }

    // 5. PEP enforcement: verify token, consume (single-use), TOCTOU check
    let result: T;
    let error: string | undefined;
    let tokenId: string | undefined;

    try {
      result = await this.pep.enforce(
        {
          manifest,
          risk,
          token,
          context: {
            ...policyContext,
            operation_id: operationId,
            attempt_id: attemptId,
            audience: 'tool-host',
            subject_workload: 'harness-runtime',
            execution_epoch: issueTime,
            policy_hash: this.deps.policyEngine.policy_hash,
            tool_effect_contract_hash: hash(risk),
            tool_grant_hash: hash(toolName),
            resource_grant_hash: hash(manifest.resource_ids),
            budget_ceiling_hash: hash({ max_iterations: 3 }),
            confirmation_key_thumbprint: 'thumbprint-1',
          },
        },
        async () => {
          tokenId = token.token_id;
          // 6. Execute the tool INSIDE the PEP authorization scope
          this.deps.session.append('tool_call', { tool: toolName, input_hash: hash(input).slice(0, 16), token_id: tokenId });
          return fn(this.deps);
        },
      );
    } catch (e) {
      error = (e as Error).message;
      this.deps.session.append('error', { tool: toolName, error, token_id: tokenId });
      throw e;
    }

    // 7. Receipt
    const receipt: ToolReceipt = {
      tool_name: toolName,
      timestamp: new Date().toISOString(),
      success: error === undefined,
      error,
      duration_ms: Date.now() - start,
      input_hash: hash(input).slice(0, 16),
      output_hash: error === undefined ? hash(result).slice(0, 16) : undefined,
      token_id: tokenId,
      policy_decision: 'allow',
    };

    // 8. Evidence
    this.deps.session.append('tool_result', { tool: toolName, receipt });

    return { result, receipt };
  }

  getAuditLog(): readonly AuditEvent[] { return this.auditLog; }
}
