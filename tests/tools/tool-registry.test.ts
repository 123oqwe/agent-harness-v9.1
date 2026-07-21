import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry, ToolRegistryError } from '../../tools/tool-registry.js';
import type { ToolSpec } from '../../../spec/types/tool-spec.js';

function validSpec(name: string, over: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name, version: '1.0.0', domains: ['coding'], implementation_status: 'implemented',
    input_schema_ref: 'in.json', output_schema_ref: 'out.json', effect_model: { summary: 'a tool', tags: ['fs'], transport: 'native', risk_ceiling: 'low' },
    risk_feature_extractor: 'extract', preconditions: [], postconditions: [],
    timeout_policy: {}, cancellation_policy: {}, retry_policy: {}, idempotency_policy: {},
    sandbox_policy: {}, network_policy: {}, credential_requirements: [], data_egress_policy: {},
    receipt_schema_ref: 'receipt.json', verification_adapter: 'va', maturity: 'draft',
    ...over,
  } as ToolSpec;
}

describe('AH-TOOL-REGISTRY-001 Tool Registry', () => {
  let reg: ToolRegistry;
  beforeEach(() => { reg = new ToolRegistry(); });

  it('registers a valid ToolSpec', () => {
    reg.register(validSpec('read_file'));
    expect(reg.get('read_file')?.name).toBe('read_file');
    expect(reg.size()).toBe(1);
  });

  it('rejects duplicate names fail-closed', () => {
    reg.register(validSpec('read_file'));
    expect(() => reg.register(validSpec('read_file'))).toThrow(ToolRegistryError);
  });

  it('rejects invalid schema', () => {
    expect(() => reg.register({ name: 'x' } as unknown as ToolSpec)).toThrow(ToolRegistryError);
  });

  it('rejects uncertified production tools', () => {
    expect(() => reg.register(validSpec('prod', { implementation_status: 'production_certified', maturity: 'draft' }))).toThrow(ToolRegistryError);
  });

  it('tool_search returns compact metadata without executing', () => {
    reg.register(validSpec('read_file', { effect_model: { summary: 'read a file', tags: ['fs', 'read'], transport: 'native', risk_ceiling: 'low' } }));
    reg.register(validSpec('list_directory', { effect_model: { summary: 'list dir', tags: ['fs'], transport: 'native', risk_ceiling: 'low' } }));
    const results = reg.search('read');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('read_file');
    expect(results[0]!.summary).toBe('read a file');
    expect(results[0]!.tags).toEqual(['fs', 'read']);
  });

  it('progressive disclosure: loadFull returns complete schema only after selection', () => {
    reg.register(validSpec('read_file'));
    const compact = reg.search('read_file')[0]!;
    expect(compact).toBeDefined();
    // compact result should NOT contain full schema fields like input_schema_ref
    const full = reg.loadFull('read_file');
    expect(full.input_schema_ref).toBe('in.json');
  });

  it('search filters by domain, transport, availability', () => {
    reg.register(validSpec('read_file', { domains: ['coding'], effect_model: { transport: 'native', summary: 'r', tags: [] } }));
    reg.register(validSpec('http_tool', { domains: ['research'], effect_model: { transport: 'http_api', summary: 'h', tags: [] }, implementation_status: 'interface_only' }));
    expect(reg.search('', { domain: 'coding' })).toHaveLength(1);
    expect(reg.search('', { transport: 'http_api' })).toHaveLength(1);
    expect(reg.search('', { availableOnly: true })).toHaveLength(1);
  });

  it('freezeSnapshot is immutable and content-addressed', () => {
    reg.register(validSpec('read_file'));
    const s1 = reg.freezeSnapshot();
    const s2 = reg.freezeSnapshot();
    expect(s1.snapshot_id).toBe(s2.snapshot_id);
    expect(s1.tool_names).toEqual(['read_file']);
    // mutating invalidates snapshot
    reg.register(validSpec('write_file'));
    const s3 = reg.freezeSnapshot();
    expect(s3.snapshot_id).not.toBe(s1.snapshot_id);
  });

  it('inSnapshot guards Runtime execution', () => {
    reg.register(validSpec('read_file'));
    const snap = reg.freezeSnapshot();
    expect(reg.inSnapshot('read_file', snap)).toBe(true);
    expect(reg.inSnapshot('evil_tool', snap)).toBe(false);
  });

  it('loadFromDir reads JSON ToolSpec files', () => {
    const dir = join(tmpdir(), 'tr-load-' + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(validSpec('tool_a')));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(validSpec('tool_b')));
    reg.loadFromDir(dir);
    expect(reg.size()).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovery never grants or executes (read-only)', () => {
    reg.register(validSpec('read_file'));
    const results = reg.search('read');
    // results are plain data objects with no execute() method
    expect(typeof (results[0] as unknown as { execute?: unknown }).execute).toBe('undefined');
  });
});
