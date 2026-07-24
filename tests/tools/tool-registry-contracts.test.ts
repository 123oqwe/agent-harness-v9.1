import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  ToolRegistryError,
  type RegistrySnapshot,
} from '../../tools/tool-registry.js';
import type { ToolSpec } from '../../contracts/index.js';

function spec(name: string, overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name,
    version: '1.0.0',
    domains: ['coding'],
    implementation_status: 'implemented',
    input_schema_ref: 'in.json',
    output_schema_ref: 'out.json',
    effect_model: {
      summary: 'a tool',
      tags: ['fs'],
      transport: 'native',
      risk_ceiling: 'low',
    },
    risk_feature_extractor: 'extract',
    preconditions: [],
    postconditions: [],
    timeout_policy: {},
    cancellation_policy: {},
    retry_policy: {},
    idempotency_policy: {},
    sandbox_policy: {},
    network_policy: {},
    credential_requirements: [],
    data_egress_policy: {},
    receipt_schema_ref: 'receipt.json',
    verification_adapter: 'va',
    maturity: 'draft',
    ...overrides,
  } as ToolSpec;
}

describe('ToolRegistry exact authority contracts', () => {
  it('uses stable error identity and messages', () => {
    const error = new ToolRegistryError('reason');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ToolRegistryError');
    expect(error.message).toBe('reason');

    const registry = new ToolRegistry();
    registry.register(spec('read_file'));
    expect(() => registry.register(spec('read_file'))).toThrowError(
      'duplicate tool name: read_file',
    );
    expect(() =>
      registry.register(
        spec('unsafe', {
          implementation_status: 'production_certified',
          maturity: 'draft',
        }),
      ),
    ).toThrowError('uncertified production tool: unsafe (maturity=draft)');
    expect(() => registry.register({ name: 'broken' } as ToolSpec)).toThrowError(
      /^invalid ToolSpec: \[/,
    );
  });

  it('returns an exact compact result with fallback metadata', () => {
    const registry = new ToolRegistry();
    registry.register(
      spec('fallback', {
        domains: ['research', 'coding'],
        effect_model: {},
        risk_feature_extractor: 'risk-extractor',
      }),
    );
    registry.register(
      spec('stubbed', {
        implementation_status: 'stub',
        effect_model: {
          summary: 'stub summary',
          tags: ['preview'],
          transport: 'http_api',
          risk_ceiling: 'high',
        },
      }),
    );
    registry.register(
      spec('interface', {
        implementation_status: 'interface_only',
        effect_model: {
          summary: 'interface summary',
          tags: [],
          transport: 'mcp',
          risk_ceiling: 'medium',
        },
      }),
    );

    expect(registry.search('  FALLBACK  ')).toEqual([
      {
        name: 'fallback',
        version: '1.0.0',
        domains: ['research', 'coding'],
        implementation_status: 'implemented',
        summary: 'risk-extractor',
        tags: [],
        risk_ceiling: undefined,
        transport: 'native',
        available: true,
      },
    ]);
    expect(registry.search('preview')).toEqual([
      {
        name: 'stubbed',
        version: '1.0.0',
        domains: ['coding'],
        implementation_status: 'stub',
        summary: 'stub summary',
        tags: ['preview'],
        risk_ceiling: 'high',
        transport: 'http_api',
        available: false,
      },
    ]);
    expect(registry.search('', { availableOnly: true }).map((item) => item.name)).toEqual([
      'fallback',
    ]);
    expect(registry.search('', { domain: 'research' }).map((item) => item.name)).toEqual([
      'fallback',
    ]);
    expect(registry.search('', { domain: 'documents' })).toEqual([]);
    expect(registry.search('', { transport: 'mcp' }).map((item) => item.name)).toEqual([
      'interface',
    ]);
    expect(registry.search('', { transport: 'native' }).map((item) => item.name)).toEqual([
      'fallback',
    ]);
    expect(registry.search('medium').map((item) => item.name)).toEqual(['interface']);
    expect(registry.search('missing')).toEqual([]);
    expect(registry.listNames()).toEqual(['fallback', 'interface', 'stubbed']);
  });

  it('freezes an exact content-addressed snapshot independent of insertion order', () => {
    const registry = new ToolRegistry();
    registry.register(spec('z_tool'));
    registry.register(spec('a_tool'));
    const snapshot = registry.freezeSnapshot();

    expect(snapshot.snapshot_id).toBe(
      'f100ae6c4d0855755b5476e5e7cc870750fbeb0750766b1b5b85b4ac9869e162',
    );
    expect(snapshot.tool_names).toEqual(['a_tool', 'z_tool']);
    expect(snapshot.entries).toEqual([
      {
        name: 'a_tool',
        version: '1.0.0',
        content_hash:
          '57b9b459a707db2941a0d78cb21e131a8d932047f27ee685520719cfcebf6afa',
      },
      {
        name: 'z_tool',
        version: '1.0.0',
        content_hash:
          '44f17fa1b2d683f049aaf74c77ad63034b48fc1cf25e8e64cf49faa4e917987f',
      },
    ]);
    expect(snapshot.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.tool_names)).toBe(true);
    expect(registry.freezeSnapshot()).toBe(snapshot);
  });

  it('canonicalizes nested object keys but preserves array order', () => {
    const left = new ToolRegistry();
    left.register(
      spec('read_file', {
        effect_model: {
          summary: 'read',
          tags: ['a', 'b'],
          nested: { z: 1, a: 2 },
        },
      }),
    );
    const right = new ToolRegistry();
    right.register(
      spec('read_file', {
        effect_model: {
          nested: { a: 2, z: 1 },
          tags: ['a', 'b'],
          summary: 'read',
        },
      }),
    );
    const reorderedArray = new ToolRegistry();
    reorderedArray.register(
      spec('read_file', {
        effect_model: {
          summary: 'read',
          tags: ['b', 'a'],
          nested: { a: 2, z: 1 },
        },
      }),
    );

    expect(left.freezeSnapshot().snapshot_id).toBe(
      right.freezeSnapshot().snapshot_id,
    );
    expect(left.freezeSnapshot().snapshot_id).not.toBe(
      reorderedArray.freezeSnapshot().snapshot_id,
    );
  });

  it('invalidates the cached snapshot after a real registry mutation', () => {
    const registry = new ToolRegistry();
    registry.register(spec('a'));
    const first = registry.freezeSnapshot();
    registry.register(spec('b'));
    const second = registry.freezeSnapshot();
    expect(second).not.toBe(first);
    expect(second.tool_names).toEqual(['a', 'b']);
    expect(second.snapshot_id).not.toBe(first.snapshot_id);
    expect(registry.size()).toBe(2);
  });

  it('checks every snapshot identity component independently', () => {
    const registry = new ToolRegistry();
    registry.register(spec('read_file'));
    const snapshot = registry.freezeSnapshot();
    const [entry] = snapshot.entries;

    const missingEntry = {
      ...snapshot,
      entries: [],
    } as unknown as RegistrySnapshot;
    const wrongVersion = {
      ...snapshot,
      entries: [{ ...entry!, version: '2.0.0' }],
    } as unknown as RegistrySnapshot;
    const wrongHash = {
      ...snapshot,
      entries: [{ ...entry!, content_hash: '0'.repeat(64) }],
    } as unknown as RegistrySnapshot;

    expect(registry.inSnapshot('missing', snapshot)).toBe(false);
    expect(registry.inSnapshot('read_file', missingEntry)).toBe(false);
    expect(registry.inSnapshot('read_file', wrongVersion)).toBe(false);
    expect(registry.inSnapshot('read_file', wrongHash)).toBe(false);
    expect(registry.inSnapshot('read_file', snapshot)).toBe(true);
    expect(() => registry.loadFull('missing', snapshot)).toThrowError(
      'tool does not match frozen snapshot: missing',
    );
  });

  it('loads only packaged JSON resources and rejects every escape form', () => {
    const registry = new ToolRegistry();
    expect(registry.loadJsonResource('schemas/read-file-input.json')).toMatchObject({
      type: 'object',
      required: ['path'],
      additionalProperties: false,
    });
    expect(() => registry.loadJsonResource('../package.json')).toThrowError(
      'tool resource escapes packaged root: ../package.json',
    );
    expect(() => registry.loadJsonResource('/etc/passwd')).toThrowError(
      'tool resource escapes packaged root: /etc/passwd',
    );
    expect(() => registry.loadJsonResource('schemas/read-file-input')).toThrowError(
      'packaged tool resource not found: schemas/read-file-input',
    );
    expect(() => registry.loadJsonResource('schemas/missing.json')).toThrowError(
      'packaged tool resource not found: schemas/missing.json',
    );
  });

  it('loads a selected provider tool with an immutable packaged input schema', () => {
    const registry = new ToolRegistry();
    registry.register(
      spec('read_file', {
        input_schema_ref: 'schemas/read-file-input.json',
        output_schema_ref: 'schemas/read-file-output.json',
      }),
    );
    const providerTool = registry.loadProviderTool(
      'read_file',
      registry.freezeSnapshot(),
    );
    expect(providerTool.name).toBe('read_file');
    expect(providerTool.input_schema).toMatchObject({
      type: 'object',
      required: ['path'],
    });
    expect(Object.isFrozen(providerTool)).toBe(true);
    expect(Object.isFrozen(providerTool.input_schema)).toBe(true);
  });
});
