import { describe, expect, it } from 'vitest';

import {
  HookSystem,
  type HookEvent,
} from '../../../packages/runtime-core/src/index.js';
import { createHarnessHookAttenuationPolicy } from '../../../runtime/hook-port.js';

const scope = Object.freeze({
  tenant_id: 'tenant-a',
  run_id: 'run-a',
  session_id: 'session-a',
  operation_id: 'operation-a',
  attempt_id: 'attempt-a',
});

const dispatchAttenuation = async (
  event: HookEvent,
  original: unknown,
  candidate: unknown,
) => {
  const system = new HookSystem(
    [
      {
        id: `attenuate-${event}`,
        event,
        trust: 'managed',
        priority: 1,
        timeout_ms: 100,
        handler: {
          handle: async () => ({ action: 'attenuate', payload: candidate }),
        },
      },
    ],
    { attenuationPolicy: createHarnessHookAttenuationPolicy() },
  );
  return system.dispatch({
    event,
    invocation_id: `invocation-${event}`,
    idempotency_key: `idempotency-${event}`,
    scope,
    payload: original,
  });
};

const providerFixture = () => ({
  registry_snapshot_hash: 'registry-a',
  request: {
    messages: [{ role: 'user', content: 'inspect the repository' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
  },
  estimated_input_tokens: 100,
  required_capabilities: ['text_reasoning', 'tool_calling'],
  requires_structured_output: false,
  data_policy: {
    local_only: true,
    allowed_regions: ['local'],
    max_retention_days: 0,
    training_allowed: false,
  },
  policy: {
    allowed_provider_ids: ['local-provider'],
    denied_provider_ids: ['remote-provider'],
  },
  run_plan: {
    allowed_provider_ids: ['local-provider'],
    required_capabilities: ['text_reasoning', 'tool_calling'],
  },
});

const providerRequest = providerFixture();

describe('AH-HOOK-001 monotonic attenuation authority', () => {
  it('rejects deleting local_only or budget constraints from UserPromptSubmit', async () => {
    const original = {
      goal: 'work locally',
      success_criteria: [
        { criterion: 'done', verification_method: 'deterministic' },
      ],
      constraints: [
        { type: 'privacy', value: 'local_only' },
        { type: 'budget', value: '1000' },
      ],
    };
    const candidate = { ...original, constraints: [] };

    await expect(
      dispatchAttenuation('user_prompt_submit', original, candidate),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_attenuation_would_expand_authority',
      payload: original,
    });
  });

  it('rejects adding provider tools', async () => {
    const candidate = structuredClone(providerRequest);
    candidate.request.tools.push({
      type: 'function',
      function: { name: 'execute_command' },
    });

    await expect(
      dispatchAttenuation(
        'before_provider_request',
        providerRequest,
        candidate,
      ),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_attenuation_would_expand_authority',
    });
  });

  it.each([
    {
      field: 'data policy',
      mutate: (candidate: ReturnType<typeof providerFixture>) => {
        candidate.data_policy.local_only = false;
        candidate.data_policy.allowed_regions.push('us');
      },
    },
    {
      field: 'policy provider set',
      mutate: (candidate: ReturnType<typeof providerFixture>) => {
        candidate.policy.allowed_provider_ids.push('remote-provider');
        candidate.policy.denied_provider_ids = [];
      },
    },
    {
      field: 'run-plan provider set',
      mutate: (candidate: ReturnType<typeof providerFixture>) => {
        candidate.run_plan.allowed_provider_ids.push('remote-provider');
        candidate.run_plan.required_capabilities = ['text_reasoning'];
      },
    },
  ])('rejects expanding $field', async ({ mutate }) => {
    const candidate = structuredClone(providerRequest);
    mutate(candidate);

    await expect(
      dispatchAttenuation(
        'before_provider_request',
        providerRequest,
        candidate,
      ),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_attenuation_would_expand_authority',
    });
  });

  it('freezes PreTurn and SessionBeforeCompact safety-bearing fields', async () => {
    await expect(
      dispatchAttenuation(
        'pre_turn',
        {
          messages: [{ role: 'user', content: 'safe' }],
          allowed_tools: ['read_file'],
        },
        {
          messages: [{ role: 'user', content: 'safe' }],
          allowed_tools: ['read_file', 'execute_command'],
        },
      ),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_attenuation_would_expand_authority',
    });

    await expect(
      dispatchAttenuation(
        'session_before_compact',
        { summary: 'safe', safety_state: { approvals: ['approval-a'] } },
        { summary: 'shorter' },
      ),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_attenuation_would_expand_authority',
    });
  });

  it('allows PreToolUse argument changes only as a candidate for downstream revalidation', async () => {
    await expect(
      dispatchAttenuation(
        'pre_tool_use',
        { path: '/workspace/original.txt' },
        { path: '/workspace/final.txt' },
      ),
    ).resolves.toMatchObject({
      action: 'continue',
      payload: { path: '/workspace/final.txt' },
    });
  });
});
