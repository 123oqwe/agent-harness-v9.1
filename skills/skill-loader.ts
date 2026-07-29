/**
 * AH-SKILL-LOADER-001: Skill Loader
 *
 * Loads full SkillSpec instructions only for the selected skill after
 * skill_search returns compact metadata. Checks required tools, allowed
 * effects, and risk ceiling before binding the frozen Skill version.
 *
 * A skill cannot add grants. It can only suggest tools; Policy decides.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillRegistry, SkillRegistrySnapshot } from './skill-registry.js';
import type { SkillSpec } from '../contracts/index.js';

export interface SkillActivationResult {
  skill: SkillSpec;
  frozen_version: string;
  required_tools_available: boolean;
  missing_tools: string[];
  risk_ceiling_satisfied: boolean;
  allowed_effects_verified: boolean;
  instructions: string;
  verification: string;
}

export class SkillLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLoaderError';
    Object.setPrototypeOf(this, SkillLoaderError.prototype);
  }
}

const RISK_TIERS: Readonly<Record<string, number>> = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  tier_1: 1,
  tier_2: 2,
  tier_3: 3,
  tier_4: 4,
});

const VALID_EFFECTS = new Set([
  'pure',
  'read_only',
  'idempotent_write',
  'non_idempotent_write',
  'irreversible',
  'read',
  'write',
  'create',
  'delete',
  'execute',
  'publish',
  'communicate',
]);

function normalizedEffects(effects: readonly string[]): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const effect of effects) {
    if (!VALID_EFFECTS.has(effect)) {
      throw new SkillLoaderError(`invalid allowed_effect_class: ${effect}`);
    }
    if (effect === 'read_only') {
      normalized.add('read');
    } else if (
      effect === 'idempotent_write' ||
      effect === 'non_idempotent_write'
    ) {
      normalized.add('write');
      normalized.add('create');
      normalized.add('delete');
    } else {
      normalized.add(effect);
    }
  }
  return normalized;
}

export class SkillLoader {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly snapshot: SkillRegistrySnapshot,
    private readonly availableTools: string[],
    private readonly maxRiskTier: number = 2,
    private readonly skillsDir?: string,
    private readonly availableToolEffects: Readonly<
      Record<string, string>
    > = {},
  ) {}

  private resourceRoot(): string {
    return this.skillsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
  }

  private readAsset(reference: string, kind: string): string {
    const root = this.resourceRoot();
    const assetPath = resolve(root, reference);
    const relativePath = relative(root, assetPath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new SkillLoaderError(`${kind} path escapes packaged resource root: ${reference}`);
    }
    try {
      return readFileSync(assetPath).toString();
    } catch {
      throw new SkillLoaderError(`${kind} asset not found: ${reference}`);
    }
  }

  /** Activate a skill by name: load full spec, check tools, effects, risk. */
  async activate(skillName: string): Promise<SkillActivationResult> {
    const skill = this.registry.getSkill(skillName);
    if (!skill) {
      throw new SkillLoaderError(`skill not found: ${skillName}`);
    }
    if (!this.registry.inSnapshot(skillName, this.snapshot)) {
      throw new SkillLoaderError(`skill not in frozen snapshot: ${skillName}`);
    }
    const frozenSkill = this.registry.loadFull(skillName, this.snapshot);

    // Check required tools are available
    const requiredTools = frozenSkill.required_tools;
    if (!requiredTools.every((tool): tool is string => typeof tool === 'string')) {
      throw new SkillLoaderError(`skill '${skillName}' has invalid required_tools`);
    }
    const availableTools = new Set(this.availableTools);
    const missingTools = requiredTools.filter((tool) => !availableTools.has(tool));
    if (missingTools.length > 0) {
      throw new SkillLoaderError(
        `skill '${skillName}' requires tools not available: ${missingTools.join(', ')}`,
      );
    }

    // Check risk ceiling
    const riskCeiling = frozenSkill.risk_ceiling;
    const ceilingTier = RISK_TIERS[riskCeiling];
    if (ceilingTier === undefined) {
      throw new SkillLoaderError(
        `skill '${skillName}' has invalid risk ceiling: ${riskCeiling}`,
      );
    }
    if (ceilingTier > this.maxRiskTier) {
      throw new SkillLoaderError(
        `skill '${skillName}' risk ceiling ${riskCeiling} exceeds max tier ${this.maxRiskTier}`,
      );
    }

    // Verify allowed effects
    const allowedEffects = frozenSkill.allowed_effect_classes;
    if (!allowedEffects.every((effect): effect is string => typeof effect === 'string')) {
      throw new SkillLoaderError(
        `skill '${skillName}' has invalid allowed_effect_classes`,
      );
    }
    let normalizedAllowedEffects: ReadonlySet<string>;
    try {
      normalizedAllowedEffects = normalizedEffects(allowedEffects);
    } catch (error) {
      throw new SkillLoaderError(
        `skill '${skillName}' ${(error as Error).message}`,
      );
    }
    for (const tool of requiredTools) {
      const effect = this.availableToolEffects[tool];
      if (effect === undefined) {
        throw new SkillLoaderError(
          `skill '${skillName}' cannot verify effect for required tool: ${tool}`,
        );
      }
      if (!normalizedAllowedEffects.has(effect)) {
        throw new SkillLoaderError(
          `skill '${skillName}' cannot activate ${tool}: effect ${effect} exceeds allowed effects`,
        );
      }
    }

    const instructions = this.readAsset(frozenSkill.workflow_template_ref, 'workflow');
    const verification = this.readAsset(frozenSkill.verification_template_ref, 'verification');

    return {
      skill: frozenSkill,
      frozen_version: frozenSkill.version,
      required_tools_available: true,
      missing_tools: [],
      risk_ceiling_satisfied: true,
      allowed_effects_verified: true,
      instructions,
      verification,
    };
  }
}
