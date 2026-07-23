/**
 * AH-ROUTER-001: Static Router
 *
 * Deterministic routing based on task features. Selects exactly one
 * reasoning strategy: direct, react, or plan_execute.
 *
 * Rules (from plan section 6):
 *   no tools + low risk + one step                         -> direct
 *   next action depends on a tool observation              -> react
 *   multiple dependent steps or transactional file changes -> plan_execute
 *   unknown/high-risk/unauthorized                          -> deny
 *
 * Same input + environment snapshot always produces same decision + reason code.
 */

import { profileIntent, type TaskFeatures, type ProfilerInput } from './intent-profiler.js';

export type ReasoningStrategy = 'direct' | 'react' | 'plan_execute';
export type RouteDecision = 'direct' | 'react' | 'plan_execute' | 'deny';

export interface RouteReasonCode {
  code: string;
  message: string;
}

export interface RoutingResult {
  strategy: RouteDecision;
  reason: RouteReasonCode;
  features: TaskFeatures;
  model_hint: string;
  frozen_snapshot: boolean;
}

export interface RouterOptions {
  policy_allows?: boolean;
  max_iterations?: number;
  budget_tokens?: number;
}

export function staticRouter(
  input: ProfilerInput,
  opts: RouterOptions = {},
): RoutingResult {
  const features = profileIntent(input);
  const policyAllows = opts.policy_allows ?? true;
  const frozenSnapshot = true;

  // Deny if policy doesn't allow
  if (!policyAllows) {
    return {
      strategy: 'deny',
      reason: { code: 'POLICY_DENIED', message: 'Policy does not allow this request' },
      features,
      model_hint: 'none',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // Deny high-risk unauthorized
  if (features.effect_risk === 'high' && features.uncertainty > 0) {
    return {
      strategy: 'deny',
      reason: { code: 'HIGH_RISK_UNCERTAIN', message: 'High risk with high uncertainty denied' },
      features,
      model_hint: 'none',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // Plan+Execute: multiple dependent steps or transactional file changes
  if (features.requires_file_transaction || (features.dependency_count >= 2) || features.steps_estimated >= 3) {
    return {
      strategy: 'plan_execute',
      reason: {
        code: 'MULTI_STEP_OR_TRANSACTIONAL',
        message: `Selected plan_execute: ${features.requires_file_transaction ? 'file transaction' : `${features.dependency_count} dependencies`}, ${features.steps_estimated} estimated steps`,
      },
      features,
      model_hint: 'scripted_test',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // ReAct: next action depends on a tool observation
  if (features.needs_tools && features.tool_count >= 1 && features.requires_interaction) {
    return {
      strategy: 'react',
      reason: {
        code: 'TOOL_OBSERVATION_DEPENDENT',
        message: `Selected react: needs ${features.tool_count} tool(s) with interaction`,
      },
      features,
      model_hint: 'scripted_test',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // ReAct: needs tools but step depends on observation (even without explicit interaction)
  if (features.needs_tools && features.uncertainty > 0) {
    return {
      strategy: 'react',
      reason: {
        code: 'OBSERVATION_DEPENDENT',
        message: `Selected react: tool use with uncertainty ${features.uncertainty}`,
      },
      features,
      model_hint: 'scripted_test',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // Direct: no tools + low risk + one step
  if (!features.needs_tools && features.effect_risk !== 'high' && features.steps_estimated <= 1) {
    return {
      strategy: 'direct',
      reason: {
        code: 'SINGLE_STEP_NO_TOOLS',
        message: 'Selected direct: single step, no tools, low risk',
      },
      features,
      model_hint: 'scripted_test',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // Default: if needs tools but no dependencies, use ReAct
  if (features.needs_tools) {
    return {
      strategy: 'react',
      reason: {
        code: 'TOOL_NEEDED',
        message: `Selected react: tool needed (${features.tool_count} tool(s))`,
      },
      features,
      model_hint: 'scripted_test',
      frozen_snapshot: frozenSnapshot,
    };
  }

  // Fallback: direct for simple tasks
  return {
    strategy: 'direct',
    reason: {
      code: 'DEFAULT_DIRECT',
      message: 'Selected direct: fallback for simple task',
    },
    features,
    model_hint: 'scripted_test',
    frozen_snapshot: frozenSnapshot,
  };
}
