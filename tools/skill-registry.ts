/**
 * AH-CAPMAP-017: Skill Registry, skill_search and base skill catalog.
 *
 * Skills are declarative only (no executable code in skill YAML). One
 * authoritative registry snapshot is shared by Router and Runtime for the
 * RunPlan lifetime. skill_search searches compact name/summary/tags/domain/
 * required-tools/risk-ceiling WITHOUT loading full instructions; full SkillSpec
 * loads only after selection. Project skills override global skills only by
 * explicit versioned precedence; duplicate or ambiguous names fail closed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import type { SkillSpec } from '../contracts/index.js';

export class SkillValidationError extends Error {
  readonly file?: string | undefined;
  constructor(message: string, file?: string | undefined) {
    super(message); this.name = 'SkillValidationError'; this.file = file;
    Object.setPrototypeOf(this, SkillValidationError.prototype);
  }
}

export interface SkillSearchResult {
  name: string;
  version: string;
  summary: string;
  tags: string[];
  domain: string;
  required_tools: unknown[];
  risk_ceiling: string;
}

export interface SkillRegistrySnapshot {
  snapshot_id: string;
  created_at: string;
  skill_names: readonly string[];
  entries: readonly SkillRegistrySnapshotEntry[];
}

export interface SkillRegistrySnapshotEntry {
  name: string;
  version: string;
  content_hash: string;
}

function findSchemaPath(filename: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '..', 'resources', 'contracts', filename);
}
const SKILL_SPEC_SCHEMA_PATH = findSchemaPath('skill-spec.schema.json');

function loadSchema(): object {
  try {
    return JSON.parse(readFileSync(SKILL_SPEC_SCHEMA_PATH).toString());
  } catch (error) {
    throw new SkillValidationError(
      `packaged SkillSpec schema unavailable: ${(error as Error).message}`,
      SKILL_SPEC_SCHEMA_PATH,
    );
  }
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }

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

function findBaseSkillsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const dirs = [
    resolve(moduleDir, '..', 'resources', 'skills'),
    resolve(moduleDir, '..', 'skills'),
  ];
  const found = dirs.find((dir) => existsSync(dir));
  if (!found) throw new SkillValidationError('packaged base skills directory not found', dirs[0]);
  return found;
}

/** The 8 declarative base skills shipped with Phase 1. */
export function baseSkills(): SkillSpec[] {
  const registry = new SkillRegistry();
  registry.loadBaseSkills();
  return registry
    .listSkills()
    .map((name) => structuredClone(registry.getSkill(name)!));
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillSpec>();
  private readonly summaries = new Map<string, { summary: string; tags: string[]; domain: string }>();
  private readonly validator: (s: unknown) => boolean;
  private readonly validateErrors: () => unknown[];
  private snapshot: SkillRegistrySnapshot | null = null;

  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(loadSchema()) as ((s: unknown) => boolean) & { errors?: unknown[] };
    this.validator = (s: unknown) => validate(s);
    this.validateErrors = () => validate.errors ?? [];
  }

  validate(spec: unknown): asserts spec is SkillSpec {
    if (!this.validator(spec)) {
      throw new SkillValidationError(`invalid SkillSpec: ${JSON.stringify(this.validateErrors()).slice(0, 400)}`);
    }
  }

  /** Register a skill with optional summary/tags/domain metadata for search. */
  register(spec: SkillSpec, meta?: { summary?: string | undefined; tags?: string[] | undefined; domain?: string | undefined }): void {
    this.validate(spec);
    if (this.skills.has(spec.name)) throw new SkillValidationError(`duplicate skill name: ${spec.name}`);
    this.skills.set(spec.name, cloneAndFreeze(spec));
    this.summaries.set(spec.name, cloneAndFreeze({
      summary: meta?.summary ?? '',
      tags: meta?.tags ?? [],
      domain: meta?.domain ?? 'general',
    }));
    this.snapshot = null;
  }

  /** Load JSON SkillSpecs atomically. Unsupported files are ignored. */
  loadSkills(dir: string): void {
    if (!existsSync(dir)) throw new SkillValidationError(`directory not found: ${dir}`, dir);
    const pending: SkillSpec[] = [];
    const pendingNames = new Set<string>();
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      let spec: unknown;
      try { spec = JSON.parse(readFileSync(fp).toString()); }
      catch (e) { throw new SkillValidationError(`failed to parse ${f}: ${(e as Error).message}`, fp); }
      try { this.validate(spec); }
      catch (e) { throw new SkillValidationError(`${(e as Error).message}`, fp); }
      if (this.skills.has(spec.name) || pendingNames.has(spec.name)) {
        throw new SkillValidationError(`duplicate skill name: ${spec.name}`, fp);
      }
      pendingNames.add(spec.name);
      pending.push(spec);
    }
    for (const spec of pending) {
      this.register(spec);
    }
  }

  /** Load the 8 Phase 1 base skills from package-relative declarative JSON. */
  loadBaseSkills(): void { this.loadSkills(findBaseSkillsDir()); }

  getSkill(name: string): SkillSpec | undefined { return this.skills.get(name); }

  loadFull(name: string, snap: SkillRegistrySnapshot): SkillSpec {
    if (!this.inSnapshot(name, snap)) {
      throw new SkillValidationError(`skill does not match frozen snapshot: ${name}`);
    }
    return this.skills.get(name)!;
  }

  inSnapshot(name: string, snap: SkillRegistrySnapshot): boolean {
    const spec = this.skills.get(name);
    const entry = snap.entries.find((candidate) => candidate.name === name);
    return (
      spec !== undefined &&
      entry !== undefined &&
      entry.version === spec.version &&
      entry.content_hash === contentHash(spec)
    );
  }
  listSkills(): string[] { return [...this.skills.keys()].sort(); }

  /** reloadSkills re-reads directory and updates cache. */
  reloadSkills(dir: string): void {
    const replacement = new SkillRegistry();
    replacement.loadSkills(dir);
    this.skills.clear();
    this.summaries.clear();
    for (const name of replacement.listSkills()) {
      this.skills.set(name, replacement.skills.get(name)!);
      this.summaries.set(name, replacement.summaries.get(name)!);
    }
    this.snapshot = null;
  }

  /**
   * skill_search: searches compact metadata (name, summary, tags, domain,
   * required tools, risk ceiling) WITHOUT loading full instructions.
   */
  skill_search(query: string, opts?: { domain?: string; riskCeiling?: string }): SkillSearchResult[] {
    const q = query.toLowerCase().trim();
    const results: SkillSearchResult[] = [];
    for (const [name, spec] of this.skills) {
      const meta = this.summaries.get(name)!;
      if (opts?.domain && meta.domain !== opts.domain) continue;
      if (opts?.riskCeiling && spec.risk_ceiling !== opts.riskCeiling) continue;
      const hay = [name, meta.summary, ...meta.tags, meta.domain, spec.risk_ceiling, spec.required_tools.join(',')].join(' ').toLowerCase();
      if (q === '' || hay.includes(q)) {
        results.push({
          name, version: spec.version,
          summary: meta.summary, tags: meta.tags, domain: meta.domain,
          required_tools: spec.required_tools, risk_ceiling: spec.risk_ceiling,
        });
      }
    }
    return cloneAndFreeze(results.sort((a, b) => a.name.localeCompare(b.name)));
  }

  freezeSnapshot(): SkillRegistrySnapshot {
    if (this.snapshot) return this.snapshot;
    const entries = [...this.skills.values()]
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
      skill_names: entries.map((entry) => entry.name),
      entries,
    });
    return this.snapshot;
  }

  size(): number { return this.skills.size; }
}
