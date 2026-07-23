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

export { createBaseSkills } from './skill-definitions.js';
