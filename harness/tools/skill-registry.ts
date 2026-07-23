/**
 * AH-CAPMAP-017: Skill Registry
 *
 * Validates, stores, and searches SkillSpec records. skill_search returns
 * compact discovery candidates only; activation still requires Capability
 * and PEP authorization. Search is not authorization.
 *
 * Phase 1 ships 8 declarative base skills:
 *  1. repository_exploration
 *  2. bug_fix
 *  3. feature_implementation
 *  4. test_and_verify
 *  5. research_with_citations
 *  6. document_summary
 *  7. writing_refinement
 *  8. dependency_aware_planning
 *
 * Invariants:
 *  - Skills are declarative (no executable code in skill definitions)
 *  - Skills cannot self-elevate permissions
 *  - Duplicate or ambiguous names fail closed
 *  - Project skills override global only by explicit versioned precedence
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillSpec {
  name: string;
  summary: string;
  tags: string[];
  version: string;
  instructions_ref: string;
  precedence_scope: 'builtin' | 'global' | 'project' | 'enterprise';
  supported_experience_profiles: unknown[];
  input_schema_ref: string;
  output_schema_ref: string;
  required_context: unknown[];
  required_tools: unknown[];
  allowed_effect_classes: unknown[];
  workflow_template_ref: string;
  verification_template_ref: string;
  failure_policy: Record<string, unknown>;
  risk_ceiling: string;
  eval_suite_ref: string;
  visible?: boolean;
}

export interface SkillSearchResult {
  name: string;
  version: string;
  summary: string;
  tags: string[];
  precedence_scope: string;
  risk_ceiling: string;
}

export interface SkillSearchOptions {
  query?: string;
  tags?: string[];
  limit?: number;
}

const REQUIRED_FIELDS: (keyof SkillSpec)[] = [
  'name', 'summary', 'tags', 'version', 'instructions_ref',
  'precedence_scope', 'supported_experience_profiles', 'input_schema_ref',
  'output_schema_ref', 'required_context', 'required_tools',
  'allowed_effect_classes', 'workflow_template_ref',
  'verification_template_ref', 'failure_policy', 'risk_ceiling',
  'eval_suite_ref',
];

const VALID_SCOPES = ['builtin', 'global', 'project', 'enterprise'];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
    Object.setPrototypeOf(this, SkillValidationError.prototype);
  }
}

export class SkillConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillConflictError';
    Object.setPrototypeOf(this, SkillConflictError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Skill Registry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private readonly skills = new Map<string, SkillSpec>();
  private readonly nameIndex = new Map<string, string[]>();

  register(spec: SkillSpec): void {
    for (const field of REQUIRED_FIELDS) {
      if (spec[field] === undefined || spec[field] === null) {
        throw new SkillValidationError(`SkillSpec missing required field: ${field}`);
      }
    }

    if (!/^[a-z][a-z0-9_-]*$/.test(spec.name)) {
      throw new SkillValidationError(`SkillSpec name '${spec.name}' must be lowercase snake/kebab-case`);
    }

    if (!VALID_SCOPES.includes(spec.precedence_scope)) {
      throw new SkillValidationError(`SkillSpec precedence_scope '${spec.precedence_scope}' is not valid`);
    }

    if (/<system>|<\|im_start|<\|im_end|ignore.*previous/i.test(spec.summary)) {
      throw new SkillValidationError('SkillSpec summary contains suspicious prompt-injection pattern');
    }

    const key = `${spec.name}@${spec.version}@${spec.precedence_scope}`;
    if (this.skills.has(key)) {
      throw new SkillConflictError(`Skill '${key}' already registered (duplicate ID)`);
    }

    // Check for name collision across scopes
    const existingKeys = this.nameIndex.get(spec.name) ?? [];
    for (const existingKey of existingKeys) {
      const existing = this.skills.get(existingKey);
      if (existing && existing.precedence_scope === spec.precedence_scope) {
        throw new SkillConflictError(
          `Skill name '${spec.name}' ambiguous: version '${existing.version}' already registered in scope '${spec.precedence_scope}'`,
        );
      }
    }

    this.skills.set(key, { ...spec, visible: spec.visible ?? true });
    this.nameIndex.set(spec.name, [...existingKeys, key]);
  }

  get(name: string, version?: string): SkillSpec | undefined {
    if (version) {
      // Search across all scopes for matching version
      const keys = this.nameIndex.get(name) ?? [];
      for (const key of keys) {
        const skill = this.skills.get(key);
        if (skill && skill.version === version) return skill;
      }
      return undefined;
    }
    // Return highest precedence, latest version
    const scopeRank: Record<string, number> = {
      builtin: 0, global: 1, project: 2, enterprise: 3,
    };
    let best: SkillSpec | undefined;
    const keys = this.nameIndex.get(name) ?? [];
    for (const key of keys) {
      const skill = this.skills.get(key);
      if (!skill) continue;
      if (!best) {
        best = skill;
        continue;
      }
      const scopeDiff = (scopeRank[skill.precedence_scope] ?? 0) - (scopeRank[best.precedence_scope] ?? 0);
      if (scopeDiff > 0 || (scopeDiff === 0 && skill.version > best.version)) {
        best = skill;
      }
    }
    return best;
  }

  list(): string[] {
    return [...this.skills.keys()];
  }

  search(opts: SkillSearchOptions = {}): SkillSearchResult[] {
    const limit = opts.limit ?? 20;
    const results: SkillSearchResult[] = [];
    const seen = new Set<string>();

    for (const skill of this.skills.values()) {
      if (skill.visible === false) continue;
      if (seen.has(skill.name)) continue;

      if (opts.tags && opts.tags.length > 0) {
        if (!opts.tags.some((t) => skill.tags.includes(t))) continue;
      }

      if (opts.query) {
        const q = opts.query.toLowerCase();
        const haystack = [skill.name, skill.summary, ...skill.tags].join(' ').toLowerCase();
        if (!haystack.includes(q)) continue;
      }

      seen.add(skill.name);
      results.push({
        name: skill.name,
        version: skill.version,
        summary: skill.summary,
        tags: [...skill.tags],
        precedence_scope: skill.precedence_scope,
        risk_ceiling: skill.risk_ceiling,
      });
    }

    return results.slice(0, limit);
  }

  count(): number {
    return this.skills.size;
  }

  has(name: string): boolean {
    return this.nameIndex.has(name);
  }
}

export function skill_search(
  registry: SkillRegistry,
  opts: SkillSearchOptions = {},
): SkillSearchResult[] {
  return registry.search(opts);
}

// ---------------------------------------------------------------------------
// Phase 1 base skills
// ---------------------------------------------------------------------------

export function createBaseSkills(): SkillSpec[] {
  return [
    {
      name: 'repository_exploration',
      summary: 'Explore a code repository structure and identify key files',
      tags: ['coding', 'exploration', 'repository'],
      version: '1.0.0',
      instructions_ref: 'skills/repository-exploration.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/repo-explore-input.json',
      output_schema_ref: 'schemas/repo-explore-output.json',
      required_context: ['repository_path'],
      required_tools: ['list_directory', 'read_file', 'search_files'],
      allowed_effect_classes: ['read_only'],
      workflow_template_ref: 'workflows/explore.md',
      verification_template_ref: 'verify/explore.md',
      failure_policy: { on_failure: 'abort', max_retries: 0 },
      risk_ceiling: 'tier_1',
      eval_suite_ref: 'evals/repo-explore.json',
    },
    {
      name: 'bug_fix',
      summary: 'Identify and fix a seeded bug in a codebase',
      tags: ['coding', 'bugfix', 'development'],
      version: '1.0.0',
      instructions_ref: 'skills/bug-fix.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/bug-fix-input.json',
      output_schema_ref: 'schemas/bug-fix-output.json',
      required_context: ['repository_path', 'bug_description'],
      required_tools: ['read_file', 'edit_file', 'search_files', 'execute_command'],
      allowed_effect_classes: ['idempotent_write'],
      workflow_template_ref: 'workflows/bugfix.md',
      verification_template_ref: 'verify/bugfix.md',
      failure_policy: { on_failure: 'rollback', max_retries: 1 },
      risk_ceiling: 'tier_2',
      eval_suite_ref: 'evals/bug-fix.json',
    },
    {
      name: 'feature_implementation',
      summary: 'Implement a new feature based on a specification',
      tags: ['coding', 'feature', 'development'],
      version: '1.0.0',
      instructions_ref: 'skills/feature-impl.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/feature-input.json',
      output_schema_ref: 'schemas/feature-output.json',
      required_context: ['repository_path', 'feature_spec'],
      required_tools: ['read_file', 'write_file', 'edit_file', 'search_files', 'execute_command'],
      allowed_effect_classes: ['non_idempotent_write'],
      workflow_template_ref: 'workflows/feature.md',
      verification_template_ref: 'verify/feature.md',
      failure_policy: { on_failure: 'rollback', max_retries: 0 },
      risk_ceiling: 'tier_3',
      eval_suite_ref: 'evals/feature.json',
    },
    {
      name: 'test_and_verify',
      summary: 'Run tests and verify code correctness',
      tags: ['coding', 'testing', 'verification'],
      version: '1.0.0',
      instructions_ref: 'skills/test-verify.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/test-input.json',
      output_schema_ref: 'schemas/test-output.json',
      required_context: ['repository_path'],
      required_tools: ['execute_command', 'read_file'],
      allowed_effect_classes: ['read_only'],
      workflow_template_ref: 'workflows/test.md',
      verification_template_ref: 'verify/test.md',
      failure_policy: { on_failure: 'report', max_retries: 1 },
      risk_ceiling: 'tier_1',
      eval_suite_ref: 'evals/test.json',
    },
    {
      name: 'research_with_citations',
      summary: 'Research a topic from local sources and report with citations',
      tags: ['research', 'citations', 'analysis'],
      version: '1.0.0',
      instructions_ref: 'skills/research.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/research-input.json',
      output_schema_ref: 'schemas/research-output.json',
      required_context: ['source_set', 'research_question'],
      required_tools: ['read_file', 'search_files', 'parse_document'],
      allowed_effect_classes: ['read_only'],
      workflow_template_ref: 'workflows/research.md',
      verification_template_ref: 'verify/research.md',
      failure_policy: { on_failure: 'partial_report', max_retries: 0 },
      risk_ceiling: 'tier_1',
      eval_suite_ref: 'evals/research.json',
    },
    {
      name: 'document_summary',
      summary: 'Parse and summarize a document with page-level citations',
      tags: ['documents', 'summary', 'parsing'],
      version: '1.0.0',
      instructions_ref: 'skills/doc-summary.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/doc-input.json',
      output_schema_ref: 'schemas/doc-output.json',
      required_context: ['document_path'],
      required_tools: ['parse_document', 'read_file'],
      allowed_effect_classes: ['read_only'],
      workflow_template_ref: 'workflows/summary.md',
      verification_template_ref: 'verify/summary.md',
      failure_policy: { on_failure: 'abort', max_retries: 0 },
      risk_ceiling: 'tier_1',
      eval_suite_ref: 'evals/doc-summary.json',
    },
    {
      name: 'writing_refinement',
      summary: 'Turn a brief into a polished draft with rubric self-check',
      tags: ['writing', 'drafting', 'editing'],
      version: '1.0.0',
      instructions_ref: 'skills/writing.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/writing-input.json',
      output_schema_ref: 'schemas/writing-output.json',
      required_context: ['brief', 'style_guide'],
      required_tools: ['create_artifact', 'write_file'],
      allowed_effect_classes: ['idempotent_write'],
      workflow_template_ref: 'workflows/writing.md',
      verification_template_ref: 'verify/writing.md',
      failure_policy: { on_failure: 'revise', max_retries: 2 },
      risk_ceiling: 'tier_2',
      eval_suite_ref: 'evals/writing.json',
    },
    {
      name: 'dependency_aware_planning',
      summary: 'Construct a dependency-valid plan and reject cyclic dependencies',
      tags: ['planning', 'dependencies', 'scheduling'],
      version: '1.0.0',
      instructions_ref: 'skills/planning.md',
      precedence_scope: 'builtin',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'schemas/planning-input.json',
      output_schema_ref: 'schemas/planning-output.json',
      required_context: ['goal', 'constraints'],
      required_tools: ['create_artifact'],
      allowed_effect_classes: ['pure'],
      workflow_template_ref: 'workflows/planning.md',
      verification_template_ref: 'verify/planning.md',
      failure_policy: { on_failure: 'replan', max_retries: 1 },
      risk_ceiling: 'tier_1',
      eval_suite_ref: 'evals/planning.json',
    },
  ];
}
