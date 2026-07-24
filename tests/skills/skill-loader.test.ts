import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry, baseSkills } from '../../tools/skill-registry.js';
import { SkillLoader } from '../../skills/skill-loader.js';

describe('Skill Loader', () => {
  let registry: SkillRegistry;
  let snapshot: ReturnType<SkillRegistry['freezeSnapshot']>;

  beforeEach(() => {
    registry = new SkillRegistry();
    for (const spec of baseSkills()) {
      registry.register(spec);
    }
    snapshot = registry.freezeSnapshot();
  });

  it('activates a skill with all required tools available', async () => {
    const loader = new SkillLoader(
      registry,
      snapshot,
      ['list_directory', 'read_file', 'search_files'],
    );
    const result = await loader.activate('repository-exploration');
    expect(result.frozen_version).toBeDefined();
    expect(result.required_tools_available).toBe(true);
    expect(result.missing_tools).toHaveLength(0);
  });

  it('throws when required tools are missing', async () => {
    const loader = new SkillLoader(registry, snapshot, []);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('tools not available');
  });

  it('throws when skill not found', async () => {
    const loader = new SkillLoader(registry, snapshot, []);
    await expect(loader.activate('nonexistent')).rejects.toThrow('skill not found');
  });

  it('throws when skill not in frozen snapshot', async () => {
    const emptyRegistry = new SkillRegistry();
    const emptySnapshot = emptyRegistry.freezeSnapshot();
    const loader = new SkillLoader(registry, emptySnapshot, ['list_directory', 'read_file', 'search_files']);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('frozen snapshot');
  });
});

describe('SkillLoader mutation-killing tests', () => {
  let registry: SkillRegistry;
  let snapshot: ReturnType<SkillRegistry['freezeSnapshot']>;

  beforeEach(() => {
    registry = new SkillRegistry();
    for (const spec of baseSkills()) {
      registry.register(spec);
    }
    snapshot = registry.freezeSnapshot();
  });

  it('returns instructions field in activation result', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined);
    const result = await loader.activate('repository-exploration');
    expect(result.instructions).toBeDefined();
    expect(typeof result.instructions).toBe('string');
  });

  it('throws on skill not in frozen snapshot', async () => {
    const emptyRegistry = new SkillRegistry();
    const emptySnapshot = emptyRegistry.freezeSnapshot();
    const loader = new SkillLoader(registry, emptySnapshot, ['list_directory', 'read_file', 'search_files']);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('frozen snapshot');
  });

  it('throws on missing required tools', async () => {
    const loader = new SkillLoader(registry, snapshot, []);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('tools not available');
  });

  it('throws on risk ceiling exceeded', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 0);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('risk ceiling');
  });

  it('throws on skill not found', async () => {
    const loader = new SkillLoader(registry, snapshot, []);
    await expect(loader.activate('nonexistent-skill')).rejects.toThrow('skill not found');
  });

  it('activates skill with all required tools available', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files']);
    const result = await loader.activate('repository-exploration');
    expect(result.required_tools_available).toBe(true);
    expect(result.missing_tools).toEqual([]);
    expect(result.risk_ceiling_satisfied).toBe(true);
    expect(result.allowed_effects_verified).toBe(true);
  });

  it('activates with default maxRiskTier of 2', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files']);
    const result = await loader.activate('repository-exploration');
    expect(result.risk_ceiling_satisfied).toBe(true);
  });

  it('validates allowed_effect_classes', async () => {
    // Base skills use 'read' and 'write' which are in the valid list
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files']);
    const result = await loader.activate('repository-exploration');
    expect(result.allowed_effects_verified).toBe(true);
  });

  it('instructions field is empty string when no skillsDir', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files']);
    const result = await loader.activate('repository-exploration');
    expect(result.instructions).toBe('');
  });

  it('frozen_version matches skill version', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files']);
    const result = await loader.activate('repository-exploration');
    expect(result.frozen_version).toBe(result.skill.version);
  });

  it('can activate bug-fix skill with its required tools', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'edit_file', 'execute_command']);
    const result = await loader.activate('bug-fix');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate feature-implementation skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'write_file', 'edit_file', 'execute_command']);
    const result = await loader.activate('feature-implementation');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate research-with-citations skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['search_files', 'read_file', 'parse_document']);
    const result = await loader.activate('research-with-citations');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate document-summary skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['parse_document', 'read_file']);
    const result = await loader.activate('document-summary');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate writing-refinement skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'write_file']);
    const result = await loader.activate('writing-refinement');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate dependency-aware-planning skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'search_files']);
    const result = await loader.activate('dependency-aware-planning');
    expect(result.required_tools_available).toBe(true);
  });

  it('rejects skill when maxRiskTier is 0 and risk ceiling is tier_1', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 0);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('risk ceiling');
  });

  it('accepts skill when maxRiskTier equals ceiling', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 1);
    const result = await loader.activate('repository-exploration');
    expect(result.risk_ceiling_satisfied).toBe(true);
  });

  it('handles skill with missing risk_ceiling (defaults to tier_1)', async () => {
    // Register a skill without risk_ceiling
    const customSpec = {
      ...baseSkills()[0]!,
      name: 'custom-no-risk',
      risk_ceiling: "",
    };
    const customRegistry = new SkillRegistry();
    customRegistry.register(customSpec);
    const customSnapshot = customRegistry.freezeSnapshot();
    const loader = new SkillLoader(customRegistry, customSnapshot, ['list_directory', 'read_file', 'search_files']);
    const result = await loader.activate('custom-no-risk');
    expect(result.risk_ceiling_satisfied).toBe(true);
  });
});
