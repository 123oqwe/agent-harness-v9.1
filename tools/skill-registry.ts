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
import { join, resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import type { SkillSpec } from '../../spec/types/skill-spec.js';

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
}

function findSchemaPath(filename: string): string {
  const candidates = [
    join(resolve(__dirname, '..', '..', 'spec', 'contracts'), filename),
    join(resolve(process.cwd(), '..', 'spec', 'contracts'), filename),
    join(resolve(process.cwd(), '..', '..', 'spec', 'contracts'), filename),
    join(resolve(process.cwd(), '..', '..', '..', 'spec', 'contracts'), filename),
    join(resolve(process.cwd(), 'spec', 'contracts'), filename),
  ];
  for (const p of candidates) { try { if (existsSync(p)) return p; } catch { /* */ } }
  return candidates[0]!;
}
const SKILL_SPEC_SCHEMA_PATH = findSchemaPath('skill-spec.schema.json');

function loadSchema(): object {
  return JSON.parse(readFileSync(SKILL_SPEC_SCHEMA_PATH, 'utf8'));
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/** The 8 declarative base skills shipped with Phase 1. */
export function baseSkills(): SkillSpec[] {
  const mk = (name: string, tools: string[], risk: string, _domain: string, _summary: string): SkillSpec => ({
    name, version: '1.0.0',
    supported_experience_profiles: ['default'],
    input_schema_ref: `schemas/skills/${name}-input.json`,
    output_schema_ref: `schemas/skills/${name}-output.json`,
    required_context: [],
    required_tools: tools,
    allowed_effect_classes: ['read', 'write'],
    workflow_template_ref: `workflows/${name}.yaml`,
    verification_template_ref: `verifications/${name}.yaml`,
    failure_policy: { on_failure: 'abort', max_retries: 0 },
    risk_ceiling: risk,
    eval_suite_ref: `evals/skills/${name}.yaml`,
    // extra metadata carried in a side-channel via a frozen extension is not allowed
    // by the schema; encode summary/domain in required_tools list ordering is wrong.
    // We keep summary/domain out of SkillSpec and in a parallel catalog map instead.
  } as SkillSpec);
  // The 8 base skills per AC: repository exploration, bug fix, feature implementation,
  // test and verify, research with citations, document summary, writing refinement,
  // dependency-aware planning.
  return [
    mk('repository-exploration', ['list_directory', 'read_file', 'search_files'], 'low', 'coding', 'Explore a repository structure'),
    mk('bug-fix', ['read_file', 'edit_file', 'execute_command_sandboxed'], 'medium', 'coding', 'Fix a bug in a repository'),
    mk('feature-implementation', ['read_file', 'write_file', 'edit_file', 'execute_command_sandboxed'], 'medium', 'coding', 'Implement a new feature'),
    mk('test-and-verify', ['read_file', 'write_file', 'execute_command_sandboxed'], 'medium', 'coding', 'Write and run tests'),
    mk('research-with-citations', ['search_files', 'read_file', 'parse_document'], 'low', 'research', 'Research with source citations'),
    mk('document-summary', ['parse_document', 'read_file'], 'low', 'documents', 'Summarize a document with page references'),
    mk('writing-refinement', ['read_file', 'write_file'], 'low', 'writing', 'Refine writing through brief, draft, self-check'),
    mk('dependency-aware-planning', ['read_file', 'search_files'], 'low', 'planning', 'Build a dependency-aware plan with DAG validation'),
  ];
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
    this.skills.set(spec.name, Object.freeze({ ...spec }));
    this.summaries.set(spec.name, { summary: meta?.summary ?? '', tags: meta?.tags ?? [], domain: meta?.domain ?? 'general' });
    this.snapshot = null;
  }

  /** loadSkills('./skills/') reads all .yaml/.json files in directory. */
  loadSkills(dir: string): void {
    if (!existsSync(dir)) throw new SkillValidationError(`directory not found: ${dir}`, dir);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') && !f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const fp = join(dir, f);
      let spec: unknown;
      try { spec = JSON.parse(readFileSync(fp, 'utf8')); }
      catch (e) { throw new SkillValidationError(`failed to parse ${f}: ${(e as Error).message}`, fp); }
      try { this.register(spec as SkillSpec, { summary: (spec as { summary?: string }).summary, tags: (spec as { tags?: string[] }).tags, domain: (spec as { domain?: string }).domain }); }
      catch (e) { throw new SkillValidationError(`${(e as Error).message}`, fp); }
    }
  }

  /** Load the 8 Phase 1 base skills from declarative JSON files in skills/. */
  loadBaseSkills(): void { this.loadSkills('skills/'); }

  getSkill(name: string): SkillSpec | undefined { return this.skills.get(name); }
  listSkills(): string[] { return [...this.skills.keys()].sort(); }

  /** reloadSkills re-reads directory and updates cache. */
  reloadSkills(dir: string): void {
    this.skills.clear(); this.summaries.clear(); this.snapshot = null;
    this.loadSkills(dir);
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
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  freezeSnapshot(): SkillRegistrySnapshot {
    if (this.snapshot) return this.snapshot;
    const set = [...this.skills.values()].map(s => JSON.stringify(s, Object.keys(s).sort())).sort().join('\n');
    const id = sha(set);
    this.snapshot = Object.freeze({ snapshot_id: id, created_at: new Date().toISOString(), skill_names: Object.freeze([...this.skills.keys()].sort()) });
    return this.snapshot;
  }

  size(): number { return this.skills.size; }
}
