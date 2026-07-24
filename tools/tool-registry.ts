/**
 * AH-TOOL-REGISTRY-001: Tool Registry + tool_search discovery.
 *
 * One authority used by Router and Runtime. Registers native, cli_wrapper, MCP
 * and http_api tools from validated ToolSpec records. Snapshots are immutable
 * and content-addressed (SHA-256 of the canonical spec set) for each RunPlan.
 *
 * tool_search returns compact metadata first and loads full schemas only for
 * selected tools (progressive disclosure). Discovery can NEVER grant or execute
 * a tool. Duplicate names, invalid schemas, unavailable toolchains and
 * uncertified production tools fail closed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import type { ToolSpec } from '../contracts/index.js';

export class ToolRegistryError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolRegistryError'; Object.setPrototypeOf(this, ToolRegistryError.prototype); }
}

/** Compact metadata returned by tool_search (progressive disclosure). */
export interface ToolSearchResult {
  name: string;
  version: string;
  domains: string[];
  implementation_status: ToolSpec['implementation_status'];
  summary: string;
  tags: string[];
  risk_ceiling?: string | undefined;
  transport: ToolSpec['effect_model'] extends Record<string, unknown> ? string : string;
  available: boolean;
}

/** An immutable, content-addressed snapshot of the registry for one RunPlan. */
export interface RegistrySnapshot {
  snapshot_id: string;          // SHA-256 of canonical spec set
  created_at: string;
  tool_names: readonly string[];
}

function findSchemaPath(filename: string): string {
  // Try env var first (set by Stryker run script), then relative paths
  const specRoot = process.env.HARNESS_SPEC_ROOT;
  if (specRoot) {
    const p = join(specRoot, 'contracts', filename);
    if (existsSync(p)) return p;
  }
  const dirs = [
    join(resolve(__dirname, '..', '..', 'spec', 'contracts')),
    join(resolve(__dirname, '..', '..', '..', 'spec', 'contracts')),
    join(resolve(__dirname, '..', '..', '..', '..', 'spec', 'contracts')),
    join(resolve(process.cwd(), '..', 'spec', 'contracts')),
    join(resolve(process.cwd(), '..', '..', 'spec', 'contracts')),
    join(resolve(process.cwd(), '..', '..', '..', 'spec', 'contracts')),
  ];
  for (const dir of dirs) {
    const p = join(dir, filename);
    try { if (existsSync(p)) return p; } catch { /* */ }
  }
  return join(dirs[0]!, filename);
}
const TOOL_SPEC_SCHEMA_PATH = findSchemaPath('tool-spec.schema.json');

function loadSchema(): object {
  return JSON.parse(readFileSync(TOOL_SPEC_SCHEMA_PATH, 'utf8'));
}

function canonical(spec: ToolSpec): string {
  return JSON.stringify(spec, Object.keys(spec).sort());
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly validator: (s: unknown) => boolean;
  private readonly validateErrors: () => unknown[];
  private snapshot: RegistrySnapshot | null = null;

  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(loadSchema()) as ((s: unknown) => boolean) & { errors?: unknown[] };
    this.validator = (s: unknown) => validate(s);
    this.validateErrors = () => validate.errors ?? [];
  }

  /** Validate a ToolSpec against the frozen contract. Throws on invalid. */
  validate(spec: unknown): asserts spec is ToolSpec {
    if (!this.validator(spec)) {
      throw new ToolRegistryError(`invalid ToolSpec: ${JSON.stringify(this.validateErrors()).slice(0, 400)}`);
    }
  }

  /** Register a tool. Duplicate names fail closed. */
  register(spec: ToolSpec): void {
    this.validate(spec);
    if (this.tools.has(spec.name)) throw new ToolRegistryError(`duplicate tool name: ${spec.name}`);
    if (spec.implementation_status === 'production_certified' && (spec.maturity as string) !== 'verified') {
      throw new ToolRegistryError(`uncertified production tool: ${spec.name} (maturity=${spec.maturity})`);
    }
    this.tools.set(spec.name, Object.freeze({ ...spec }));
    this.snapshot = null; // invalidate snapshot on mutation
  }

  /** Bulk load from a directory of JSON ToolSpec files. */
  loadFromDir(dir: string): void {
    if (!existsSync(dir)) throw new ToolRegistryError(`directory not found: ${dir}`);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      this.register(spec);
    }
  }

  get(name: string): ToolSpec | undefined { return this.tools.get(name); }

  /** Full ToolSpec loaded only after selection (progressive disclosure). */
  loadFull(name: string): ToolSpec {
    const t = this.tools.get(name);
    if (!t) throw new ToolRegistryError(`tool not found: ${name}`);
    return t;
  }

  listNames(): string[] { return [...this.tools.keys()].sort(); }

  /**
   * tool_search: searches compact metadata (name, summary, tags, domain, effect,
   * risk, transport, availability) WITHOUT executing the tool. Returns compact
   * results; caller loads full schema only for selected tools.
   */
  search(query: string, opts?: { domain?: string; transport?: string; availableOnly?: boolean }): ToolSearchResult[] {
    const q = query.toLowerCase().trim();
    const results: ToolSearchResult[] = [];
    for (const spec of this.tools.values()) {
      const compact = this.toCompact(spec);
      if (opts?.domain && !spec.domains.includes(opts.domain)) continue;
      if (opts?.transport && compact.transport !== opts.transport) continue;
      if (opts?.availableOnly && !compact.available) continue;
      const hay = [spec.name, compact.summary, ...compact.tags, ...spec.domains, compact.transport, compact.risk_ceiling ?? ''].join(' ').toLowerCase();
      if (q === '' || hay.includes(q)) results.push(compact);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  private toCompact(spec: ToolSpec): ToolSearchResult {
    const effect = (spec.effect_model as Record<string, unknown> | null);
    return {
      name: spec.name,
      version: spec.version,
      domains: spec.domains,
      implementation_status: spec.implementation_status,
      summary: String((effect as Record<string, unknown> | undefined)?.summary ?? spec.risk_feature_extractor),
      tags: Array.isArray((effect as Record<string, unknown> | undefined)?.tags) ? ((effect as Record<string, unknown>)!.tags as string[]) : [],
      risk_ceiling: typeof (effect as Record<string, unknown> | undefined)?.risk_ceiling === 'string' ? (effect as Record<string, unknown>).risk_ceiling as string : undefined,
      transport: String((effect as Record<string, unknown> | undefined)?.transport ?? 'native'),
      available: spec.implementation_status !== 'interface_only' && spec.implementation_status !== 'stub',
    };
  }

  /** Freeze an immutable, content-addressed snapshot for a RunPlan. */
  freezeSnapshot(): RegistrySnapshot {
    if (this.snapshot) return this.snapshot;
    const canonicalSet = [...this.tools.values()].map(canonical).sort().join('\n');
    const id = sha(canonicalSet);
    this.snapshot = Object.freeze({
      snapshot_id: id,
      created_at: new Date().toISOString(),
      tool_names: Object.freeze([...this.tools.keys()].sort()),
    });
    return this.snapshot;
  }

  /** Verify a tool is present in a frozen snapshot (Runtime guard). */
  inSnapshot(name: string, snap: RegistrySnapshot): boolean {
    return snap.tool_names.includes(name) && this.tools.has(name);
  }

  size(): number { return this.tools.size; }
}
