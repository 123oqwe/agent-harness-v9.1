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
