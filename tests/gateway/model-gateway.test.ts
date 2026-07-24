import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  FrozenProviderRegistry,
  ModelGateway,
  ProviderConfigurationError,
  ProviderDispatchError,
  ProviderResolutionError,
  type EgressPolicyPort,
  type GatewayProviderRegistration,
  type GatewayProviderRuntime,
  type ProviderSelectionRequest,
  type SecretsBrokerPort,
  type UsageMeterPort,
} from '../../gateway/model-gateway.js';
import {
  ProviderHttpError,
  ScriptedTestProvider,
  scriptedProviderContract,
  type ParsedResponse,
} from '../../gateway/scripted-provider.js';

const SPEC_ROOT = process.env.HARNESS_SPEC_ROOT
  ? resolve(process.env.HARNESS_SPEC_ROOT)
  : resolve(import.meta.dirname, '../../../spec');

function makeRuntime(
  response: ParsedResponse = {
    content: 'ok',
    model: 'scripted',
    stop_reason: 'stop',
    usage: { input_tokens: 3, output_tokens: 2 },
  },
) {
  const provider = new ScriptedTestProvider({ queue: [response] });
  const contexts: unknown[] = [];
  const runtime: GatewayProviderRuntime = {
    provider_type: provider.provider_type,
    normalizeRequest: provider.normalizeRequest.bind(provider),
    parseResponse: provider.parseResponse.bind(provider),
    normalizeToolCall: provider.normalizeToolCall.bind(provider),
    streamEvents: provider.streamEvents.bind(provider),
    mapError: provider.mapError.bind(provider),
    meterUsage: provider.meterUsage.bind(provider),
    checkHealth: provider.checkHealth.bind(provider),
    validateDataPolicy: provider.validateDataPolicy.bind(provider),
    resolve(request, context) {
      contexts.push(context);
      return provider.resolve(request);
    },
  };
  return { contexts, provider, runtime };
}

function makeRegistration(
  providerId: string,
  overrides: Partial<GatewayProviderRegistration['metadata']> = {},
  runtime = makeRuntime().runtime,
): GatewayProviderRegistration {
  return {
    provider_id: providerId,
    contract: scriptedProviderContract,
    adapter: runtime,
    metadata: {
      capabilities: ['structured_output', 'text_reasoning', 'tool_calling'],
      max_context_tokens: 8_192,
      structured_output: true,
      tool_calling: true,
      data_policy: {
        execution: 'local',
        regions: ['local'],
        retention_days: 0,
        training_allowed: false,
      },
      pricing: {
        currency: 'USD',
        input_per_million: 1,
        output_per_million: 2,
      },
      health: 'healthy',
      network: { required: false },
      credentials: { required: false, audience: 'scripted-test' },
      ...overrides,
    },
  };
}

function makeSelection(
  snapshotHash: string,
  overrides: Partial<ProviderSelectionRequest> = {},
): ProviderSelectionRequest {
  return {
    registry_snapshot_hash: snapshotHash,
    request: {
      messages: [{ role: 'user', content: 'Rewrite this sentence.' }],
      max_tokens: 64,
    },
    estimated_input_tokens: 16,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    data_policy: {
      local_only: true,
      allowed_regions: ['local'],
      max_retention_days: 0,
      training_allowed: false,
    },
    policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: undefined, required_capabilities: ['text_reasoning'] },
    ...overrides,
  };
}

function makePorts() {
  const credentialLease = Object.freeze({
    lease_id: 'lease-1',
    audience: 'provider-api',
    expires_at: '2030-01-01T00:00:00.000Z',
  });
  const secretsBroker: SecretsBrokerPort = {
    exchangeCredential: vi.fn(async () => credentialLease),
  };
  const egressPolicy: EgressPolicyPort = {
    authorize: vi.fn(async () => ({ allowed: true })),
  };
  const usageMeter: UsageMeterPort = {
    record: vi.fn(async () => undefined),
  };
  const clock = {
    now: vi.fn(() => Date.now()),
    sleep: vi.fn(async () => undefined),
  };
  return { credentialLease, egressPolicy, secretsBroker, usageMeter, clock };
}

function setField(target: unknown, field: string, value: unknown): unknown {
  (target as Record<string, unknown>)[field] = value;
  return target;
}

function deleteField(target: unknown, field: string): unknown {
  delete (target as Record<string, unknown>)[field];
  return target;
}

function expectConfigurationFailure(operation: () => unknown, message: string) {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProviderConfigurationError);
  expect((failure as Error).message).toBe(message);
}

describe('AH-GATEWAY-PROVIDER-001: generated ProviderAdapter contract', () => {
  it('uses the generated ProviderAdapter descriptor for both scripted and real registrations', () => {
    const schema = JSON.parse(
      readFileSync(resolve(SPEC_ROOT, 'contracts/provider-adapter.schema.json'), 'utf8'),
    ) as { required: string[] };

    expect(Object.keys(scriptedProviderContract).sort()).toEqual([...schema.required].sort());
    expect(scriptedProviderContract.provider_type).toBe('scripted_test');
  });
});

describe('AH-GATEWAY-PROVIDER-001: frozen Provider Registry metadata', () => {
  it('registers capability, context, structured-output, tool, data-policy, cost and health metadata', () => {
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a')]);

    expect(registry.snapshot.providers).toEqual([
      expect.objectContaining({
        provider_id: 'provider-a',
        provider_type: 'scripted_test',
        capabilities: ['structured_output', 'text_reasoning', 'tool_calling'],
        max_context_tokens: 8_192,
        structured_output: true,
        tool_calling: true,
        health: 'healthy',
      }),
    ]);
    expect(registry.snapshot.providers[0]).not.toHaveProperty('adapter');
  });

  it('deep-copies, sorts, freezes and content-addresses a deterministic snapshot', () => {
    const original = makeRegistration('provider-b');
    const first = new FrozenProviderRegistry([original, makeRegistration('provider-a')]);
    const second = new FrozenProviderRegistry([
      makeRegistration('provider-a'),
      makeRegistration('provider-b'),
    ]);

    original.metadata.capabilities.push('vision_understanding');
    expect(first.snapshot.providers.map((provider) => provider.provider_id)).toEqual([
      'provider-a',
      'provider-b',
    ]);
    expect(first.snapshot.hash).toBe(second.snapshot.hash);
    expect(first.snapshot.providers[1]?.capabilities).not.toContain('vision_understanding');
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.providers)).toBe(true);
    expect(Object.isFrozen(first.snapshot.providers[0]?.data_policy)).toBe(true);
  });

  it('rejects duplicate identities, mismatched contracts and malformed metadata fail closed', () => {
    expect(
      () =>
        new FrozenProviderRegistry([
          makeRegistration('duplicate'),
          makeRegistration('duplicate'),
        ]),
    ).toThrowError(ProviderConfigurationError);

    const mismatch = makeRegistration('mismatch');
    mismatch.adapter.provider_type = 'local';
    expect(() => new FrozenProviderRegistry([mismatch])).toThrow(/provider_type/u);

    const malformed = makeRegistration('malformed') as unknown as {
      metadata: { max_context_tokens: number; unexpected: boolean };
    };
    malformed.metadata.max_context_tokens = 0;
    malformed.metadata.unexpected = true;
    expect(
      () => new FrozenProviderRegistry([malformed as unknown as GatewayProviderRegistration]),
    ).toThrowError(ProviderConfigurationError);
  });

  it('accepts the verified ScriptedTestProvider instance through the same runtime interface', async () => {
    const provider = new ScriptedTestProvider({
      queue: [{ content: 'direct instance', stop_reason: 'stop' }],
    });
    const registration = makeRegistration(
      'scripted-direct',
      {},
      provider as GatewayProviderRuntime,
    );
    const registry = new FrozenProviderRegistry([registration]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash);

    await expect(
      gateway.dispatch(gateway.resolve(request), request, { operation_id: 'direct-instance' }),
    ).resolves.toMatchObject({ response: { content: 'direct instance' } });
  });

  it('captures adapter methods at registration so later mutation cannot change a frozen snapshot', async () => {
    const { runtime } = makeRuntime({ content: 'captured', stop_reason: 'stop' });
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a', {}, runtime)]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash);
    runtime.resolve = vi.fn(() => {
      throw new Error('mutated adapter bypass');
    });

    await expect(
      gateway.dispatch(gateway.resolve(request), request, { operation_id: 'captured-adapter' }),
    ).resolves.toMatchObject({ response: { content: 'captured' } });
  });

  it('rejects provider types outside the generated Contract enum', () => {
    const registration = makeRegistration('unknown-type');
    registration.contract = {
      ...registration.contract,
      provider_type: 'rogue',
    } as unknown as GatewayProviderRegistration['contract'];
    registration.adapter.provider_type = 'rogue' as GatewayProviderRuntime['provider_type'];

    expectConfigurationFailure(
      () => new FrozenProviderRegistry([registration]),
      'providers[0].contract.provider_type is unsupported',
    );
  });
});

describe('AH-GATEWAY-PROVIDER-001: registration validation fails closed', () => {
  const invalidRegistrations: ReadonlyArray<
    readonly [string, () => unknown, string]
  > = [
    [
      'registration collection',
      () => null,
      'provider registrations must be an array',
    ],
    ['registration shape', () => [null], 'providers[0] must be an object'],
    [
      'registration unknown field',
      () => [setField(makeRegistration('provider-a'), 'unexpected', true)],
      'providers[0] contains unknown field: unexpected',
    ],
    [
      'provider identity',
      () => [setField(makeRegistration('provider-a'), 'provider_id', ' ')],
      'providers[0].provider_id must be a non-empty string',
    ],
    [
      'contract shape',
      () => [setField(makeRegistration('provider-a'), 'contract', null)],
      'providers[0].contract must be an object',
    ],
    [
      'contract unknown field',
      () => {
        const registration = makeRegistration('provider-a');
        registration.contract = {
          ...registration.contract,
          unexpected: true,
        } as unknown as GatewayProviderRegistration['contract'];
        return [registration];
      },
      'providers[0].contract contains unknown field: unexpected',
    ],
    [
      'required contract method',
      () => {
        const registration = makeRegistration('provider-a');
        registration.contract = { ...registration.contract, normalize_request: false };
        return [registration];
      },
      'providers[0].contract.normalize_request must be true',
    ],
    [
      'optional contract method',
      () => {
        const registration = makeRegistration('provider-a');
        registration.contract = {
          ...registration.contract,
          rate_limiter: 'yes',
        } as unknown as GatewayProviderRegistration['contract'];
        return [registration];
      },
      'providers[0].contract.rate_limiter must be a boolean',
    ],
    [
      'adapter shape',
      () => [setField(makeRegistration('provider-a'), 'adapter', null)],
      'providers[0].adapter must be an object',
    ],
    [
      'adapter method',
      () => {
        const registration = makeRegistration('provider-a');
        deleteField(registration.adapter, 'resolve');
        return [registration];
      },
      'providers[0].adapter.resolve must be a function',
    ],
    [
      'metadata shape',
      () => [setField(makeRegistration('provider-a'), 'metadata', null)],
      'providers[0].metadata must be an object',
    ],
    [
      'metadata unknown field',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata, 'unexpected', true);
        return [registration];
      },
      'providers[0].metadata contains unknown field: unexpected',
    ],
    [
      'health state',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata, 'health', 'unknown');
        return [registration];
      },
      'providers[0].metadata.health is unsupported',
    ],
    [
      'capability array',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata, 'capabilities', 'text_reasoning');
        return [registration];
      },
      'providers[0].metadata.capabilities must be an array',
    ],
    [
      'empty capabilities',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.capabilities = [];
        return [registration];
      },
      'providers[0].metadata.capabilities must not be empty',
    ],
    [
      'duplicate capabilities',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.capabilities = ['text_reasoning', 'text_reasoning'];
        return [registration];
      },
      'providers[0].metadata.capabilities must not contain duplicates',
    ],
    [
      'empty capability',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.capabilities = [''];
        return [registration];
      },
      'providers[0].metadata.capabilities[0] must be a non-empty string',
    ],
    [
      'context boundary',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.max_context_tokens = 0;
        return [registration];
      },
      'providers[0].metadata.max_context_tokens must be a safe integer >= 1',
    ],
    [
      'structured output flag',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata, 'structured_output', 'yes');
        return [registration];
      },
      'providers[0].metadata.structured_output must be a boolean',
    ],
    [
      'data policy shape',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata, 'data_policy', null);
        return [registration];
      },
      'providers[0].metadata.data_policy must be an object',
    ],
    [
      'data execution',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata.data_policy, 'execution', 'hybrid');
        return [registration];
      },
      'providers[0].metadata.data_policy.execution is unsupported',
    ],
    [
      'empty regions',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.data_policy.regions = [];
        return [registration];
      },
      'providers[0].metadata.data_policy.regions must not be empty',
    ],
    [
      'retention boundary',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.data_policy.retention_days = -1;
        return [registration];
      },
      'providers[0].metadata.data_policy.retention_days must be a safe integer >= 0',
    ],
    [
      'training flag',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata.data_policy, 'training_allowed', 'no');
        return [registration];
      },
      'providers[0].metadata.data_policy.training_allowed must be a boolean',
    ],
    [
      'pricing currency',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata.pricing, 'currency', 'EUR');
        return [registration];
      },
      'providers[0].metadata.pricing.currency must be USD in Phase 1',
    ],
    [
      'negative price',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.pricing.input_per_million = -1;
        return [registration];
      },
      'providers[0].metadata.pricing.input_per_million must be a finite non-negative number',
    ],
    [
      'network destination without network',
      () => {
        const registration = makeRegistration('provider-a');
        setField(registration.metadata.network, 'destination', 'https://provider.invalid');
        return [registration];
      },
      'providers[0].metadata.network.destination requires network.required=true',
    ],
    [
      'invalid network origin',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.network = { required: true, destination: 'not-a-url' };
        return [registration];
      },
      'providers[0].metadata.network.destination must be a valid HTTPS origin',
    ],
    [
      'insecure network origin',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.network = { required: true, destination: 'http://provider.invalid' };
        return [registration];
      },
      'providers[0].metadata.network.destination must be a valid HTTPS origin',
    ],
    [
      'credential audience',
      () => {
        const registration = makeRegistration('provider-a');
        registration.metadata.credentials.audience = '';
        return [registration];
      },
      'providers[0].metadata.credentials.audience must be a non-empty string',
    ],
  ];

  it.each(invalidRegistrations)('rejects invalid %s', (_label, createInput, message) => {
    const input = createInput();
    expectConfigurationFailure(
      () => new FrozenProviderRegistry(input as readonly GatewayProviderRegistration[]),
      message,
    );
  });
});

describe('AH-GATEWAY-PROVIDER-001: deterministic Phase 1 resolution', () => {
  it('selects deterministically by compatible price then provider identity', () => {
    const registry = new FrozenProviderRegistry([
      makeRegistration('provider-z', {
        pricing: { currency: 'USD', input_per_million: 2, output_per_million: 2 },
      }),
      makeRegistration('provider-b'),
      makeRegistration('provider-a'),
    ]);
    const ports = makePorts();
    const gateway = new ModelGateway(registry, ports);
    const request = makeSelection(registry.snapshot.hash);

    expect(gateway.resolve(request)).toEqual(gateway.resolve(request));
    expect(gateway.resolve(request).provider_id).toBe('provider-a');
    expect(gateway.resolve(request).registry_snapshot_hash).toBe(registry.snapshot.hash);
    expect(ports.secretsBroker.exchangeCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['context length', { estimated_input_tokens: 9_000 }],
    ['structured output', { requires_structured_output: true }],
    ['required capability', { required_capabilities: ['vision_understanding'] }],
  ])('rejects a provider that cannot satisfy %s', (_label, requestOverride) => {
    const registry = new FrozenProviderRegistry([
      makeRegistration('limited', {
        capabilities: ['text_reasoning'],
        max_context_tokens: 128,
        structured_output: false,
      }),
    ]);
    const gateway = new ModelGateway(registry, makePorts());

    expect(() => gateway.resolve(makeSelection(registry.snapshot.hash, requestOverride))).toThrowError(
      ProviderResolutionError,
    );
  });

  it('revalidates tool serialization and tool-calling compatibility', () => {
    const registry = new FrozenProviderRegistry([
      makeRegistration('no-tools', { tool_calling: false }),
    ]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash, {
      request: {
        messages: [{ role: 'user', content: 'Read a file.' }],
        tools: [{ name: 'read_file' }],
      },
    });

    expect(() => gateway.resolve(request)).toThrowError(ProviderResolutionError);
  });

  it('enforces the intersection of Policy and frozen RunPlan provider constraints', () => {
    const registry = new FrozenProviderRegistry([
      makeRegistration('provider-a'),
      makeRegistration('provider-b'),
    ]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash, {
      policy: { allowed_provider_ids: ['provider-a'], denied_provider_ids: [] },
      run_plan: {
        allowed_provider_ids: ['provider-b'],
        required_capabilities: ['text_reasoning'],
      },
    });

    expect(() => gateway.resolve(request)).toThrowError(ProviderResolutionError);
  });

  it('rejects a stale registry hash instead of weakening the frozen RunPlan', () => {
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a')]);
    const gateway = new ModelGateway(registry, makePorts());

    expect(() => gateway.resolve(makeSelection('0'.repeat(64)))).toThrowError(
      expect.objectContaining({ code: 'stale_registry_snapshot' }),
    );
  });

  it.each([
    [
      'local-only',
      { data_policy: { execution: 'remote', regions: ['us'], retention_days: 0, training_allowed: false } },
    ],
    [
      'region',
      { data_policy: { execution: 'remote', regions: ['eu'], retention_days: 0, training_allowed: false } },
    ],
    [
      'retention',
      { data_policy: { execution: 'local', regions: ['local'], retention_days: 30, training_allowed: false } },
    ],
    [
      'training',
      { data_policy: { execution: 'local', regions: ['local'], retention_days: 0, training_allowed: true } },
    ],
  ])('fails closed when provider metadata violates %s data policy', (_label, metadataOverride) => {
    const registry = new FrozenProviderRegistry([
      makeRegistration('provider-a', metadataOverride as Partial<GatewayProviderRegistration['metadata']>),
    ]);
    const gateway = new ModelGateway(registry, makePorts());

    expect(() => gateway.resolve(makeSelection(registry.snapshot.hash))).toThrowError(
      ProviderResolutionError,
    );
  });

  it('switches providers only through a fresh compatibility validation and never loops to attempted ids', () => {
    const registry = new FrozenProviderRegistry([
      makeRegistration('provider-a'),
      makeRegistration('provider-b'),
      makeRegistration('provider-c', { max_context_tokens: 8 }),
    ]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash);
    const first = gateway.resolve(request);
    const second = gateway.switchProvider(first, request);

    expect(first.provider_id).toBe('provider-a');
    expect(second.provider_id).toBe('provider-b');
    expect(() => gateway.switchProvider(second, request, [first.provider_id])).toThrowError(
      ProviderResolutionError,
    );
  });

  it.each(['tool serialization', 'adapter data policy'] as const)(
    'revalidates %s when switching providers',
    (validation) => {
      const fallback = makeRuntime().runtime;
      if (validation === 'tool serialization') {
        fallback.normalizeRequest = vi.fn(() => {
          throw new Error('unsupported serialization');
        });
      } else {
        fallback.validateDataPolicy = vi.fn(() => ({ allowed: false, reason: 'provider denied' }));
      }
      const registry = new FrozenProviderRegistry([
        makeRegistration('provider-a'),
        makeRegistration('provider-b', {}, fallback),
      ]);
      const gateway = new ModelGateway(registry, makePorts());
      const request = makeSelection(registry.snapshot.hash);

      expect(() => gateway.switchProvider(gateway.resolve(request), request)).toThrowError(
        ProviderResolutionError,
      );
    },
  );
});

describe('AH-GATEWAY-PROVIDER-001: selection constraints are strictly validated', () => {
  function invalidSelection(
    mutate: (request: ProviderSelectionRequest) => unknown,
  ): readonly [unknown, string] {
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a')]);
    const request = makeSelection(registry.snapshot.hash);
    return [mutate(request), registry.snapshot.hash];
  }

  const invalidSelections: ReadonlyArray<
    readonly [string, () => readonly [unknown, string], string]
  > = [
    ['shape', () => [null, ''], 'selection must be an object'],
    [
      'unknown field',
      () =>
        invalidSelection((request) => {
          setField(request, 'unexpected', true);
          return request;
        }),
      'selection contains unknown field: unexpected',
    ],
    [
      'snapshot hash',
      () => invalidSelection((request) => setField(request, 'registry_snapshot_hash', 'bad')),
      'selection.registry_snapshot_hash must be SHA-256',
    ],
    [
      'token estimate',
      () => invalidSelection((request) => setField(request, 'estimated_input_tokens', -1)),
      'selection.estimated_input_tokens must be a safe integer >= 0',
    ],
    [
      'capability list',
      () => invalidSelection((request) => setField(request, 'required_capabilities', 'code')),
      'selection.required_capabilities must be an array',
    ],
    [
      'structured output flag',
      () => invalidSelection((request) => setField(request, 'requires_structured_output', 'yes')),
      'selection.requires_structured_output must be a boolean',
    ],
    [
      'required data policy',
      () => invalidSelection((request) => setField(request, 'data_policy', null)),
      'selection.data_policy must be an object',
    ],
    [
      'allowed data regions',
      () =>
        invalidSelection((request) => {
          setField(request.data_policy, 'allowed_regions', []);
          return request;
        }),
      'selection.data_policy.allowed_regions must not be empty',
    ],
    [
      'Policy shape',
      () => invalidSelection((request) => setField(request, 'policy', null)),
      'selection.policy must be an object',
    ],
    [
      'Policy duplicate deny',
      () =>
        invalidSelection((request) => {
          setField(request.policy, 'denied_provider_ids', ['provider-a', 'provider-a']);
          return request;
        }),
      'selection.policy.denied_provider_ids must not contain duplicates',
    ],
    [
      'RunPlan shape',
      () => invalidSelection((request) => setField(request, 'run_plan', null)),
      'selection.run_plan must be an object',
    ],
    [
      'RunPlan duplicate capability',
      () =>
        invalidSelection((request) => {
          setField(request.run_plan, 'required_capabilities', [
            'text_reasoning',
            'text_reasoning',
          ]);
          return request;
        }),
      'selection.run_plan.required_capabilities must not contain duplicates',
    ],
  ];

  it.each(invalidSelections)('rejects invalid %s', (_label, createInput, message) => {
    const [input] = createInput();
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a')]);
    const gateway = new ModelGateway(registry, makePorts());
    if (isSelectionWithHash(input) && /^[0-9a-f]{64}$/u.test(input.registry_snapshot_hash)) {
      input.registry_snapshot_hash = registry.snapshot.hash;
    }
    expectConfigurationFailure(
      () => gateway.resolve(input as ProviderSelectionRequest),
      message,
    );
  });
});

function isSelectionWithHash(value: unknown): value is ProviderSelectionRequest {
  return typeof value === 'object' && value !== null && 'registry_snapshot_hash' in value;
}

describe('AH-GATEWAY-PROVIDER-001: mandatory dispatch controls', () => {
  it('routes every dispatch through data policy, egress, Secrets Broker and usage metering', async () => {
    const { contexts, runtime } = makeRuntime();
    const validateDataPolicy = vi.spyOn(runtime, 'validateDataPolicy');
    const registry = new FrozenProviderRegistry([
      makeRegistration(
        'remote-provider',
        {
          data_policy: {
            execution: 'remote',
            regions: ['eu'],
            retention_days: 0,
            training_allowed: false,
          },
          network: { required: true, destination: 'https://provider.invalid' },
          credentials: { required: true, audience: 'provider-api' },
        },
        runtime,
      ),
    ]);
    const ports = makePorts();
    const gateway = new ModelGateway(registry, ports);
    const request = makeSelection(registry.snapshot.hash, {
      data_policy: {
        local_only: false,
        allowed_regions: ['eu'],
        max_retention_days: 0,
        training_allowed: false,
      },
    });
    const selected = gateway.resolve(request);

    expect(ports.secretsBroker.exchangeCredential).not.toHaveBeenCalled();
    const result = await gateway.dispatch(selected, request, { operation_id: 'operation-1' });

    expect(validateDataPolicy).toHaveBeenCalled();
    expect(ports.egressPolicy.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_id: 'remote-provider',
        destination: 'https://provider.invalid',
      }),
    );
    expect(ports.secretsBroker.exchangeCredential).toHaveBeenCalledWith({
      provider_id: 'remote-provider',
      audience: 'provider-api',
      operation_id: 'operation-1',
    });
    expect(contexts).toEqual([
      expect.objectContaining({ credential: ports.credentialLease, operation_id: 'operation-1' }),
    ]);
    expect(ports.usageMeter.record).toHaveBeenCalledWith({
      provider_id: 'remote-provider',
      operation_id: 'operation-1',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(result.response.content).toBe('ok');
  });

  it('denies data-policy and egress violations before credential exchange or provider execution', async () => {
    const { provider, runtime } = makeRuntime();
    const registry = new FrozenProviderRegistry([
      makeRegistration(
        'remote-provider',
        {
          data_policy: {
            execution: 'remote',
            regions: ['eu'],
            retention_days: 0,
            training_allowed: false,
          },
          network: { required: true, destination: 'https://provider.invalid' },
          credentials: { required: true, audience: 'provider-api' },
        },
        runtime,
      ),
    ]);
    const ports = makePorts();
    ports.egressPolicy.authorize = vi.fn(async () => ({ allowed: false, reason: 'blocked' }));
    const gateway = new ModelGateway(registry, ports);
    const request = makeSelection(registry.snapshot.hash, {
      data_policy: {
        local_only: false,
        allowed_regions: ['eu'],
        max_retention_days: 0,
        training_allowed: false,
      },
    });

    await expect(
      gateway.dispatch(gateway.resolve(request), request, { operation_id: 'operation-2' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(ports.secretsBroker.exchangeCredential).not.toHaveBeenCalled();
    expect(provider.callCount).toBe(0);
    expect(ports.usageMeter.record).not.toHaveBeenCalled();
  });

  it('normalizes provider errors and never returns raw provider failures', async () => {
    const { runtime } = makeRuntime();
    runtime.resolve = vi.fn(() => {
      throw new ProviderHttpError(429, 'credential-like-sensitive-detail');
    });
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a', {}, runtime)]);
    const ports = makePorts();
    const gateway = new ModelGateway(registry, ports);
    const request = makeSelection(registry.snapshot.hash);

    const failure = await gateway
      .dispatch(gateway.resolve(request), request, { operation_id: 'operation-3' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderDispatchError);
    expect(failure).toMatchObject({
      code: 'provider_failure',
      provider_error: { kind: 'rate_limited', retryable: true, status: 429 },
    });
    expect(JSON.stringify(failure)).not.toContain('credential-like-sensitive-detail');
  });

  it.each([
    ['egress policy failure', 'egress_policy_failure'],
    ['credential exchange failure', 'credential_exchange_failed'],
    ['usage metering failure', 'metering_failed'],
  ] as const)('fails closed on %s', async (failurePoint, expectedCode) => {
    const { runtime } = makeRuntime();
    const remoteMetadata: Partial<GatewayProviderRegistration['metadata']> = {
      data_policy: {
        execution: 'remote',
        regions: ['eu'],
        retention_days: 0,
        training_allowed: false,
      },
      network: { required: true, destination: 'https://provider.invalid' },
      credentials: { required: true, audience: 'provider-api' },
    };
    const registry = new FrozenProviderRegistry([
      makeRegistration('remote-provider', remoteMetadata, runtime),
    ]);
    const ports = makePorts();
    if (failurePoint === 'egress policy failure') {
      ports.egressPolicy.authorize = vi.fn(async () => {
        throw new Error('egress unavailable');
      });
    } else if (failurePoint === 'credential exchange failure') {
      ports.secretsBroker.exchangeCredential = vi.fn(async () => {
        throw new Error('credential unavailable');
      });
    } else {
      ports.usageMeter.record = vi.fn(async () => {
        throw new Error('meter unavailable');
      });
    }
    const gateway = new ModelGateway(registry, ports);
    const request = makeSelection(registry.snapshot.hash, {
      data_policy: {
        local_only: false,
        allowed_regions: ['eu'],
        max_retention_days: 0,
        training_allowed: false,
      },
    });

    await expect(
      gateway.dispatch(gateway.resolve(request), request, { operation_id: 'controlled-failure' }),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it('falls back to a generic normalized error when an adapter error mapper fails', async () => {
    const { runtime } = makeRuntime();
    runtime.resolve = vi.fn(() => {
      throw new Error('raw failure');
    });
    runtime.mapError = vi.fn(() => {
      throw new Error('mapper failure');
    });
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a', {}, runtime)]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash);

    await expect(
      gateway.dispatch(gateway.resolve(request), request, { operation_id: 'mapper-failure' }),
    ).rejects.toMatchObject({
      code: 'provider_failure',
      provider_error: {
        kind: 'unknown',
        retryable: false,
        detail: 'Provider error normalization failed',
      },
    });
  });

  it('requires every security control port at construction', () => {
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a')]);
    expectConfigurationFailure(
      () => new ModelGateway(registry, null as unknown as ReturnType<typeof makePorts>),
      'ModelGateway control ports are required',
    );
    expectConfigurationFailure(
      () =>
        new ModelGateway(registry, {
          ...makePorts(),
          egressPolicy: {} as EgressPolicyPort,
        }),
      'egressPolicy.authorize must be a function',
    );
  });

  it('captures security ports at construction so later mutation cannot bypass egress denial', async () => {
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a')]);
    const ports = makePorts();
    ports.egressPolicy.authorize = vi.fn(async () => ({ allowed: false, reason: 'frozen deny' }));
    const gateway = new ModelGateway(registry, ports);
    const request = makeSelection(registry.snapshot.hash);
    ports.egressPolicy.authorize = vi.fn(async () => ({ allowed: true }));

    await expect(
      gateway.dispatch(gateway.resolve(request), request, { operation_id: 'frozen-egress' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('fails closed when runtime health changes or the selected request is altered before dispatch', async () => {
    const { runtime } = makeRuntime();
    runtime.checkHealth = vi.fn(async () => 'down' as const);
    const registry = new FrozenProviderRegistry([makeRegistration('provider-a', {}, runtime)]);
    const gateway = new ModelGateway(registry, makePorts());
    const request = makeSelection(registry.snapshot.hash);
    const selected = gateway.resolve(request);

    await expect(
      gateway.dispatch(selected, request, { operation_id: 'operation-4' }),
    ).rejects.toMatchObject({ code: 'provider_unhealthy' });

    const altered = makeSelection(registry.snapshot.hash, {
      policy: { allowed_provider_ids: [], denied_provider_ids: ['provider-a'] },
    });
    await expect(
      gateway.dispatch(selected, altered, { operation_id: 'operation-5' }),
    ).rejects.toMatchObject({ code: 'provider_no_longer_compatible' });
  });

  it('keeps ambient credentials out of immutable registry snapshots', () => {
    const ambientMarker = 'must-not-enter-the-registry';
    process.env.MODEL_GATEWAY_TEST_API_KEY = ambientMarker;
    const registry = new FrozenProviderRegistry([
      makeRegistration('provider-a', {
        credentials: { required: true, audience: 'provider-api' },
      }),
    ]);

    try {
      expect(JSON.stringify(registry.snapshot)).not.toContain(ambientMarker);
      expect(JSON.stringify(registry.snapshot)).not.toContain('credentialLease');
      expect(JSON.stringify(registry.snapshot)).not.toContain('api_key');
    } finally {
      delete process.env.MODEL_GATEWAY_TEST_API_KEY;
    }
  });
});
