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
import type { SandboxProfile } from '../sandbox/process-sandbox.js';
import type { ToolRegistry, RegistrySnapshot } from './tool-registry.js';
import type { ToolSpec } from '../contracts/index.js';
import type { PolicyEngine } from '../security/policy-engine.js';
import type { PolicyContext } from '../security/policy-engine.js';
import type { EffectRisk } from '../contracts/index.js';
import type { ActionManifest } from '../contracts/index.js';
import type { CapabilityToken } from '../contracts/index.js';
import type { DurableSession } from '../session/durable-session.js';
import type { AuthorizationService } from '../security/authorization-service.js';
import type { CapabilityStateStore } from '../security/capability.js';
import type { PolicyEnforcementPoint} from '../security/pep.js';
import type { ConsentService } from '../security/consent.js';

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
  derived_risk_tier?: number | undefined;
  side_effect_class?: string | undefined;
  budget_ceiling_hash?: string | undefined;
}

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry;
  snapshot: RegistrySnapshot;
  vfs: VirtualFilesystem;
  sandbox?: SandboxProfile;
  policyEngine: PolicyEngine;
  session: DurableSession;
  /** Dispatch-scoped credentials. Present only inside an authorized effect. */
  credentials?: Readonly<Record<string, Uint8Array>>;
}

export interface ToolCredentialLease {
  readonly values: Readonly<Record<string, Uint8Array>>;
  clear(): void;
}

export interface ToolCredentialBrokerPort {
  exchange(input: {
    readonly tool_name: string;
    readonly requirements: readonly Readonly<Record<string, unknown>>[];
    readonly operation_id: string;
    readonly token_id: string;
  }): Promise<ToolCredentialLease>;
}

export interface PostconditionVerifierPort {
  verify(input: {
    readonly tool: ToolSpec;
    readonly result: unknown;
  }): Promise<{ readonly valid: boolean; readonly reason?: string }>;
}

export type EffectState =
  | 'PRE_DISPATCH'
  | 'IN_FLIGHT'
  | 'EFFECT_UNKNOWN'
  | 'EFFECT_CONFIRMED'
  | 'DEFINITELY_FAILED_NO_EFFECT';

export interface EffectJournalRecord {
  readonly operation_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt_id: string;
  readonly tool_name: string;
  readonly idempotency_key: string;
  readonly effect_state: EffectState;
  readonly receipt_json: string | null;
}

export interface EffectJournalPort {
  getOperationByIdempotencyKey(
    key: string,
  ): EffectJournalRecord | null;
  recordOperation(record: EffectJournalRecord): void;
  recordReceipt?(
    operationId: string,
    receipt: {
      readonly tool_name: string;
      readonly success: boolean;
      readonly input_hash: string;
      readonly output_hash: string | null;
      readonly duration_ms: number;
      readonly timestamp: string;
    },
  ): void;
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
  if (typeof args.cwd === 'string') ids.push(args.cwd);
  if (Array.isArray(args.sources)) for (const src of args.sources) if (typeof src === 'string') ids.push(src);
  return ids;
}

/** Build a minimal ActionManifest for a tool call. */
function buildManifest(
  toolSpec: ToolSpec,
  input: unknown,
  policyVersion: string,
  taskId: string,
  planId: string,
  stepId: string,
  risk: EffectRisk,
  issuedAt: string,
): ActionManifest {
  const toolName = toolSpec.name;
  const isWrite = ['write', 'delete', 'create'].includes(risk.operation);
  const hasExternalEffect = !['read'].includes(risk.operation);
  const canonicalArgs = input as Record<string, unknown>;
  const manifestHash = hash({ toolName, input, policyVersion });
  return {
    task_id: taskId,
    plan_id: planId,
    step_id: stepId,
    tool_name: toolName,
    tool_version: toolSpec.version,
    schema_hash: manifestHash,
    canonical_args: canonicalArgs,
    resource_ids: extractResourceIds(canonicalArgs),
    resource_versions: {},
    preconditions: Object.fromEntries(
      toolSpec.preconditions.map((condition, index) => [
        String(condition.id ?? index),
        condition,
      ]),
    ),
    expected_postconditions: Object.fromEntries(
      toolSpec.postconditions.map((condition, index) => [
        String(condition.id ?? index),
        condition,
      ]),
    ),
    reads: isWrite ? [] : Object.keys(canonicalArgs),
    writes: isWrite ? Object.keys(canonicalArgs) : [],
    external_effects: [],
    side_effect_class: isWrite
      ? 'idempotent_write'
      : hasExternalEffect
        ? 'non_idempotent_write'
        : 'read_only',
    credential_scope: toolSpec.credential_requirements.map((requirement) =>
      String(requirement.name ?? requirement.scope ?? 'credential'),
    ),
    max_attempts: 1,
    max_cost: {},
    expires_at: new Date(Date.parse(issuedAt) + 300_000).toISOString(),
    compensation_plan: null,
    policy_version: policyVersion,
    manifest_hash: manifestHash,
  };
}

export interface ToolExecutorInjectedDeps {
  authz: AuthorizationService;
  pep: PolicyEnforcementPoint;
  stateStore: CapabilityStateStore;
  now: () => string;
  consent?: ConsentService;
  credentialBroker?: ToolCredentialBrokerPort | undefined;
  postconditionVerifier?: PostconditionVerifierPort;
  effectJournal?: EffectJournalPort | undefined;
  /** Execution context providing tenant_id, user_id, run_id, etc. */
  execCtx?: {
    tenant_id: string;
    user_id: string;
    run_id: string;
    plan_id: string;
    step_id: string;
    attempt_id: string;
    operation_id: string;
    idempotency_key: string;
    confirmation_key_thumbprint: string;
    run_phase?: 'setup' | 'agent';
    budget?: Readonly<Record<string, number>>;
  };
}

export class ToolExecutor {
  private readonly authz: AuthorizationService;
  private readonly pep: PolicyEnforcementPoint;
  private readonly stateStore: CapabilityStateStore;
  private readonly injectedNow: () => string;

 constructor(private deps: ToolExecutorDeps, injected: ToolExecutorInjectedDeps) {
   this.authz = injected.authz;
   this.pep = injected.pep;
   this.stateStore = injected.stateStore;
   this.injectedNow = injected.now;
   this.injected = injected;
 }
 private readonly injected: ToolExecutorInjectedDeps;

 async execute<T>(
  toolName: string,
  input: unknown,
  fn: (deps: ToolExecutorDeps) => Promise<T>,
  verifyResult?: (result: T) => Promise<void> | void,
 ): Promise<{ result: T; receipt: ToolReceipt }> {
   const start = Date.now();
  const ctx = this.injected.execCtx;
  // ExecutionContext is required — no fallback to default identity in production path
  if (!ctx) throw new ToolExecutorError('ExecutionContext is required — no default identity allowed');
  const operationId = ctx.operation_id;
  const attemptId = ctx.attempt_id;
  const tenantId = ctx.tenant_id;
  const userId = ctx.user_id;
  const planId = ctx.plan_id;
  const stepId = ctx.step_id;
  const thumbprint = ctx.confirmation_key_thumbprint;
  const idempotencyKey = ctx.idempotency_key;

   const existingEffect =
     this.injected.effectJournal?.getOperationByIdempotencyKey(idempotencyKey);
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
    const toolSpec = this.deps.toolRegistry.loadFull(toolName, this.deps.snapshot);
    const risk = extractRisk(toolSpec);
   const issueTime = this.injectedNow();
   const budget = ctx.budget ?? { max_iterations: 3 };
   const manifest = buildManifest(
     toolSpec,
     input,
     policy.version,
     ctx.run_id,
     planId,
     stepId,
     risk,
     issueTime,
   );
   const policyContext: PolicyContext = {
     tenant_id: tenantId,
     user_id: userId,
     run_phase: ctx.run_phase ?? 'agent',
     trust_level: 'untrusted',
     now: issueTime,
    };

    // 4. Issue a single-use capability token
    let token: CapabilityToken;
    let tier: number | undefined;
    let effectPrepared = false;
    let effectStarted = false;
    try {
      const decision = this.deps.policyEngine.evaluate({
        tool_name: toolName,
        resource_ids: manifest.resource_ids,
        risk,
        context: policyContext,
      });
      tier = decision.derived_risk_tier;
      if (!decision.allowed) {
        this.deps.session.append('error', { tool: toolName, reason: `policy denied: ${decision.reason_code}` });
        throw new ToolExecutorError(`policy denied: ${decision.reason_code}`);
      }
      if (this.injected.consent) {
        const consent = await this.injected.consent.request({
          tool_name: toolName,
          risk_tier: decision.derived_risk_tier,
          manifest_preview: JSON.stringify({
            tool_name: toolName,
            resource_ids: manifest.resource_ids,
            side_effect_class: manifest.side_effect_class,
          }),
        });
        if (!consent.granted) {
          this.deps.session.append('error', {
            tool: toolName,
            reason: `consent denied: ${consent.reason ?? consent.level}`,
          });
          throw new ToolExecutorError(
            `consent denied: ${consent.reason ?? consent.level}`,
          );
        }
      }
      if (existingEffect?.effect_state === 'EFFECT_CONFIRMED') {
        if (!existingEffect.receipt_json) {
          throw new ToolExecutorError(
            'confirmed effect is missing its stored outcome',
          );
        }
        try {
          const stored = JSON.parse(existingEffect.receipt_json) as {
            result: T;
            receipt: ToolReceipt;
          };
          if (
            existingEffect.run_id !== ctx.run_id ||
            existingEffect.operation_id !== operationId ||
            existingEffect.tool_name !== toolName ||
            !stored.receipt ||
            stored.receipt.tool_name !== toolName ||
            stored.receipt.input_hash !== hash(input).slice(0, 16) ||
            stored.receipt.success !== true
          ) {
            throw new Error('stored outcome does not match action identity');
          }
          this.deps.session.append('tool_result', {
            tool: toolName,
            receipt: stored.receipt,
            replayed: true,
          });
          return Object.freeze({
            result: stored.result,
            receipt: Object.freeze(stored.receipt),
          });
        } catch (error) {
          if (error instanceof ToolExecutorError) throw error;
          throw new ToolExecutorError(
            `stored effect outcome is invalid: ${(error as Error).message}`,
          );
        }
      }
      if (
        existingEffect?.effect_state === 'IN_FLIGHT' ||
        existingEffect?.effect_state === 'EFFECT_UNKNOWN'
      ) {
        throw new ToolExecutorError(
          `effect requires reconciliation: ${existingEffect.effect_state}`,
        );
      }
      const signedToken = await this.authz.issue({
        operation_id: operationId,
        attempt_id: attemptId,
        manifest_hash: manifest.manifest_hash,
        policy_decision_hash: decision.decision_hash,
        tool_effect_contract_hash: hash(risk),
       subject_workload: 'harness-runtime',
       tenant_id: tenantId,
       audience: 'tool-host',
       tool_grant_hash: hash(toolName),
       resource_grant_hash: hash(manifest.resource_ids),
       budget_ceiling_hash: hash(budget),
       execution_epoch: issueTime,
       confirmation_key_thumbprint: thumbprint,
       not_before: issueTime,
        expires_at: new Date(Date.parse(issueTime) + 300_000).toISOString(),
      });
      token = signedToken.claims;
      if (this.injected.effectJournal) {
        this.injected.effectJournal.recordOperation({
          operation_id: operationId,
          run_id: ctx.run_id,
          step_id: stepId,
          attempt_id: attemptId,
          tool_name: toolName,
          idempotency_key: idempotencyKey,
          effect_state: 'PRE_DISPATCH',
          receipt_json: null,
        });
        effectPrepared = true;
      }
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
           budget_ceiling_hash: hash(budget),
           confirmation_key_thumbprint: thumbprint,
         },
        },
        async () => {
          tokenId = token.token_id;
          if (this.injected.effectJournal) {
            this.injected.effectJournal.recordOperation({
              operation_id: operationId,
              run_id: ctx.run_id,
              step_id: stepId,
              attempt_id: attemptId,
              tool_name: toolName,
              idempotency_key: idempotencyKey,
              effect_state: 'IN_FLIGHT',
              receipt_json: null,
            });
          }
          effectStarted = true;
          // 6. Execute the tool INSIDE the PEP authorization scope
          this.deps.session.append('tool_call', { tool: toolName, input_hash: hash(input).slice(0, 16), token_id: tokenId });
          const requirements = toolSpec?.credential_requirements ?? [];
          if (requirements.length === 0) return fn(this.deps);
          if (!this.injected.credentialBroker) {
            throw new ToolExecutorError(
              `credential broker required for tool: ${toolName}`,
            );
          }
          const lease = await this.injected.credentialBroker.exchange({
            tool_name: toolName,
            requirements,
            operation_id: operationId,
            token_id: token.token_id,
          });
          try {
            return await fn({ ...this.deps, credentials: lease.values });
          } finally {
            lease.clear();
          }
        },
      );
      if (this.injected.postconditionVerifier && toolSpec) {
        const verification = await this.injected.postconditionVerifier.verify({
          tool: toolSpec,
          result,
        });
        if (!verification.valid) {
          throw new ToolExecutorError(
            `postcondition verification failed: ${verification.reason ?? 'unspecified'}`,
          );
        }
      }
      await verifyResult?.(result);
    } catch (e) {
      error = (e as Error).message;
      if (this.injected.effectJournal && effectPrepared) {
        this.injected.effectJournal.recordOperation({
          operation_id: operationId,
          run_id: ctx.run_id,
          step_id: stepId,
          attempt_id: attemptId,
          tool_name: toolName,
          idempotency_key: idempotencyKey,
          effect_state: effectStarted
            ? 'EFFECT_UNKNOWN'
            : 'DEFINITELY_FAILED_NO_EFFECT',
          receipt_json: null,
        });
      }
      this.deps.session.append('error', { tool: toolName, error, token_id: tokenId });
      throw e;
    }

    // 7. Receipt
    const receipt: ToolReceipt = Object.freeze({
      tool_name: toolName,
      timestamp: new Date().toISOString(),
      success: error === undefined,
      error,
      duration_ms: Math.max(1, Date.now() - start),
      input_hash: hash(input).slice(0, 16),
      output_hash: error === undefined ? hash(result).slice(0, 16) : undefined,
      token_id: tokenId,
      policy_decision: 'allow',
      derived_risk_tier: tier,
      side_effect_class: manifest.side_effect_class,
      budget_ceiling_hash: hash(budget),
    });

    // 8. Evidence
    this.deps.session.append('tool_result', { tool: toolName, receipt });
    if (this.injected.effectJournal) {
      this.injected.effectJournal.recordOperation({
        operation_id: operationId,
        run_id: ctx.run_id,
        step_id: stepId,
        attempt_id: attemptId,
        tool_name: toolName,
        idempotency_key: idempotencyKey,
        effect_state: 'EFFECT_CONFIRMED',
        receipt_json: JSON.stringify({ result, receipt }),
      });
      this.injected.effectJournal.recordReceipt?.(operationId, {
        tool_name: receipt.tool_name,
        success: receipt.success,
        input_hash: receipt.input_hash,
        output_hash: receipt.output_hash ?? null,
        duration_ms: receipt.duration_ms,
        timestamp: receipt.timestamp,
      });
    }

    return { result, receipt };
  }
}
