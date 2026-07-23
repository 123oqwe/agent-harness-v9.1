/**
 * AH-TOOL-REGISTRY-001: Tool Registry
 *
 * Validates, stores, and searches ToolSpec records. tool_search returns
 * compact discovery candidates only; invocation still requires Capability
 * and PEP authorization. Search is not authorization.
 *
 * Invariants:
 *  - Duplicate tool IDs (name + version) are rejected
 *  - Untrusted overrides are rejected
 *  - Hidden tools are not disclosed in search results
 *  - Prompt-injected metadata is sanitized
 *  - Schema validation on every registration
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  summary: string;
  tags: string[];
  version: string;
  domains: string[];
  implementation_status: string;
  input_schema_ref: string;
  output_schema_ref: string;
  effect_model: Record<string, unknown>;
  risk_feature_extractor: string;
  preconditions: Record<string, unknown>[];
  postconditions: Record<string, unknown>[];
  timeout_policy: Record<string, unknown>;
  cancellation_policy: Record<string, unknown>;
  retry_policy: Record<string, unknown>;
  idempotency_policy: Record<string, unknown>;
  sandbox_policy: Record<string, unknown>;
  network_policy: Record<string, unknown>;
  credential_requirements: Record<string, unknown>[];
  data_egress_policy: Record<string, unknown>;
  receipt_schema_ref: string;
  verification_adapter: string;
  maturity: string;
  transport?: string;
  tool_group?: string;
  cli_toolchain_ref?: string;
  run_phase_binding?: string[];
  visible?: boolean;
}

export interface SearchResult {
  name: string;
  version: string;
  summary: string;
  tags: string[];
  domains: string[];
  tool_group?: string;
}

export interface ToolSearchOptions {
  query?: string;
  tags?: string[];
  domains?: string[];
  tool_group?: string;
  limit?: number;
}

const REQUIRED_FIELDS: (keyof ToolSpec)[] = [
  'name', 'summary', 'tags', 'version', 'domains',
  'implementation_status', 'input_schema_ref', 'output_schema_ref',
  'effect_model', 'risk_feature_extractor', 'preconditions',
  'postconditions', 'timeout_policy', 'cancellation_policy',
  'retry_policy', 'idempotency_policy', 'sandbox_policy',
  'network_policy', 'credential_requirements', 'data_egress_policy',
  'receipt_schema_ref', 'verification_adapter', 'maturity',
];

const VALID_MATURITY = ['draft', 'mock', 'sandbox_verified', 'provider_sandbox_verified', 'production_certified'];
const VALID_STATUS = ['interface_only', 'stub', 'mock', 'partial', 'implemented', 'verified', 'production_certified'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
    Object.setPrototypeOf(this, ToolValidationError.prototype);
  }
}

export class ToolConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolConflictError';
    Object.setPrototypeOf(this, ToolConflictError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly specHashes = new Map<string, string>();

  register(spec: ToolSpec): void {
    for (const field of REQUIRED_FIELDS) {
      if (spec[field] === undefined || spec[field] === null) {
        throw new ToolValidationError(`ToolSpec missing required field: ${field}`);
      }
    }

    if (!/^[a-z][a-z0-9_-]*$/.test(spec.name)) {
      throw new ToolValidationError(`ToolSpec name '${spec.name}' must be lowercase snake/kebab-case`);
    }

    if (!VALID_MATURITY.includes(spec.maturity)) {
      throw new ToolValidationError(`ToolSpec maturity '${spec.maturity}' is not valid`);
    }

    if (!VALID_STATUS.includes(spec.implementation_status)) {
      throw new ToolValidationError(`ToolSpec implementation_status '${spec.implementation_status}' is not valid`);
    }

    if (/<system>|<\|im_start|<\|im_end|ignore.*previous/i.test(spec.summary)) {
      throw new ToolValidationError('ToolSpec summary contains suspicious prompt-injection pattern');
    }

    const key = `${spec.name}@${spec.version}`;
    if (this.tools.has(key)) {
      throw new ToolConflictError(`Tool '${key}' already registered (duplicate ID)`);
    }

    const hash = this.hashSpec(spec);
    if (this.specHashes.has(hash) && this.specHashes.get(hash) !== key) {
      throw new ToolConflictError('Tool spec hash collision: untrusted override attempt detected');
    }

    this.tools.set(key, { ...spec, visible: spec.visible ?? true });
    this.specHashes.set(hash, key);
  }

  get(name: string, version?: string): ToolSpec | undefined {
    if (version) {
      return this.tools.get(`${name}@${version}`);
    }
    let latest: ToolSpec | undefined;
    for (const tool of this.tools.values()) {
      if (tool.name === name) {
        if (!latest || tool.version > latest.version) {
          latest = tool;
        }
      }
    }
    return latest;
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  search(opts: ToolSearchOptions = {}): SearchResult[] {
    const limit = opts.limit ?? 20;
    const results: SearchResult[] = [];

    for (const tool of this.tools.values()) {
      if (tool.visible === false) continue;

      if (opts.tags && opts.tags.length > 0) {
        if (!opts.tags.some((t) => tool.tags.includes(t))) continue;
      }

      if (opts.domains && opts.domains.length > 0) {
        if (!opts.domains.some((d) => tool.domains.includes(d))) continue;
      }

      if (opts.tool_group && tool.tool_group !== opts.tool_group) continue;

      if (opts.query) {
        const q = opts.query.toLowerCase();
        const haystack = [tool.name, tool.summary, ...tool.tags].join(' ').toLowerCase();
        if (!haystack.includes(q)) continue;
      }

      results.push({
        name: tool.name,
        version: tool.version,
        summary: tool.summary,
        tags: [...tool.tags],
        domains: [...tool.domains],
        tool_group: tool.tool_group,
      });
    }

    return results.slice(0, limit);
  }

  count(): number {
    return this.tools.size;
  }

  has(name: string, version?: string): boolean {
    if (version) return this.tools.has(`${name}@${version}`);
    return this.get(name) !== undefined;
  }

  private hashSpec(spec: ToolSpec): string {
    const payload = JSON.stringify({
      name: spec.name,
      version: spec.version,
      input_schema_ref: spec.input_schema_ref,
      output_schema_ref: spec.output_schema_ref,
      effect_model: spec.effect_model,
    });
    return createHash('sha256').update(payload).digest('hex');
  }
}

export function tool_search(
  registry: ToolRegistry,
  opts: ToolSearchOptions = {},
): SearchResult[] {
  return registry.search(opts);
}
