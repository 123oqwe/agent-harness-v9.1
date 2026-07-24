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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  entries: readonly RegistrySnapshotEntry[];
}

export interface RegistrySnapshotEntry {
  name: string;
  version: string;
  content_hash: string;
}

export type ProviderToolSpec = ToolSpec & {
  readonly input_schema: Readonly<Record<string, unknown>>;
};

function findSchemaPath(filename: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '..', 'resources', 'contracts', filename);
}
const TOOL_SPEC_SCHEMA_PATH = findSchemaPath('tool-spec.schema.json');

function loadSchema(): object {
  try {
    return JSON.parse(readFileSync(TOOL_SPEC_SCHEMA_PATH, 'utf8'));
  } catch (error) {
    throw new ToolRegistryError(
      `packaged ToolSpec schema unavailable: ${(error as Error).message}`,
    );
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }

function contentHash(value: unknown): string { return sha(canonical(value)); }

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

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
    if (
      spec.implementation_status === 'production_certified' &&
      spec.maturity !== 'production_certified'
    ) {
      throw new ToolRegistryError(`uncertified production tool: ${spec.name} (maturity=${spec.maturity})`);
    }
    this.tools.set(spec.name, cloneAndFreeze(spec));
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

  loadJsonResource(reference: string): object {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
    const resourcePath = resolve(root, reference);
    const relativePath = relative(root, resourcePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new ToolRegistryError(`tool resource escapes packaged root: ${reference}`);
    }
    if (!reference.endsWith('.json') || !existsSync(resourcePath)) {
      throw new ToolRegistryError(`packaged tool resource not found: ${reference}`);
    }
    try {
      return JSON.parse(readFileSync(resourcePath, 'utf8'));
    } catch (error) {
      throw new ToolRegistryError(
        `invalid packaged tool resource ${reference}: ${(error as Error).message}`,
      );
    }
  }

  /** Full ToolSpec loaded only after selection (progressive disclosure). */
  loadFull(name: string, snap: RegistrySnapshot): ToolSpec {
    if (!this.inSnapshot(name, snap)) {
      throw new ToolRegistryError(`tool does not match frozen snapshot: ${name}`);
    }
    const t = this.tools.get(name);
    if (!t) throw new ToolRegistryError(`tool not found: ${name}`);
    return t;
  }

  /** Load the selected frozen tool plus its actual packaged input schema. */
  loadProviderTool(name: string, snap: RegistrySnapshot): ProviderToolSpec {
    const spec = this.loadFull(name, snap);
    const schema = this.loadJsonResource(spec.input_schema_ref);
    return cloneAndFreeze({
      ...spec,
      input_schema: schema as Record<string, unknown>,
    });
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
    const entries = [...this.tools.values()]
      .map((spec) => cloneAndFreeze({
        name: spec.name,
        version: spec.version,
        content_hash: contentHash(spec),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const id = contentHash(entries);
    this.snapshot = cloneAndFreeze({
      snapshot_id: id,
      created_at: new Date().toISOString(),
      tool_names: entries.map((entry) => entry.name),
      entries,
    });
    return this.snapshot;
  }

  /** Verify a tool is present in a frozen snapshot (Runtime guard). */
  inSnapshot(name: string, snap: RegistrySnapshot): boolean {
    const spec = this.tools.get(name);
    const entry = snap.entries.find((candidate) => candidate.name === name);
    return (
      spec !== undefined &&
      entry !== undefined &&
      entry.version === spec.version &&
      entry.content_hash === contentHash(spec)
    );
  }

  size(): number { return this.tools.size; }
}
