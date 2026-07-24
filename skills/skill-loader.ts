/**
 * AH-SKILL-LOADER-001: Skill Loader
 *
 * Loads full SkillSpec instructions only for the selected skill after
 * skill_search returns compact metadata. Checks required tools, allowed
 * effects, and risk ceiling before binding the frozen Skill version.
 *
 * A skill cannot add grants. It can only suggest tools; Policy decides.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SkillRegistry, SkillRegistrySnapshot } from '../tools/skill-registry.js';
import type { SkillSpec } from '../contracts/index.js';

export interface SkillActivationResult {
  skill: SkillSpec;
  frozen_version: string;
  required_tools_available: boolean;
  missing_tools: string[];
  risk_ceiling_satisfied: boolean;
  allowed_effects_verified: boolean;
  instructions: string;
}

export class SkillLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLoaderError';
    Object.setPrototypeOf(this, SkillLoaderError.prototype);
  }
}

export class SkillLoader {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly snapshot: SkillRegistrySnapshot,
    private readonly availableTools: string[],
    private readonly maxRiskTier: number = 2,
    private readonly skillsDir?: string,
  ) {}

  /** Activate a skill by name: load full spec, check tools, effects, risk. */
  async activate(skillName: string): Promise<SkillActivationResult> {
    const skill = this.registry.getSkill(skillName);
    if (!skill) {
      throw new SkillLoaderError(`skill not found: ${skillName}`);
    }

    // Verify skill is in frozen snapshot
    if (!this.snapshot.skill_names.includes(skillName)) {
      throw new SkillLoaderError(`skill not in frozen snapshot: ${skillName}`);
    }

    // Check required tools are available
    const requiredTools = (skill.required_tools as string[]) ?? [];
    const missingTools = requiredTools.filter((t) => !this.availableTools.includes(t));
    if (missingTools.length > 0) {
      throw new SkillLoaderError(
        `skill '${skillName}' requires tools not available: ${missingTools.join(', ')}`,
      );
    }

    // Check risk ceiling
    const riskCeiling = skill.risk_ceiling ?? 'tier_1';
    const ceilingTier = parseInt(riskCeiling.replace('tier_', ''), 10) || 1;
    if (ceilingTier > this.maxRiskTier) {
      throw new SkillLoaderError(
        `skill '${skillName}' risk ceiling ${riskCeiling} exceeds max tier ${this.maxRiskTier}`,
      );
    }

    // Verify allowed effects
    const allowedEffects = (skill.allowed_effect_classes as string[]) ?? ['read_only'];
    const validEffects = ['pure', 'read_only', 'idempotent_write', 'non_idempotent_write', 'irreversible', 'read', 'write', 'create', 'delete', 'execute', 'publish', 'communicate'];
    for (const e of allowedEffects) {
      if (!validEffects.includes(e)) {
        throw new SkillLoaderError(`skill '${skillName}' has invalid allowed_effect_class: ${e}`);
      }
    }

    // Load full instructions if a path is specified
    let instructions = '';
    if (this.skillsDir && skill.workflow_template_ref) {
      const instrPath = resolve(this.skillsDir, skill.workflow_template_ref);
      if (existsSync(instrPath)) {
        instructions = readFileSync(instrPath, 'utf8');
      }
    }

    return {
      skill,
      frozen_version: skill.version,
      required_tools_available: true,
      missing_tools: [],
      risk_ceiling_satisfied: true,
      allowed_effects_verified: true,
      instructions,
    };
  }
}
