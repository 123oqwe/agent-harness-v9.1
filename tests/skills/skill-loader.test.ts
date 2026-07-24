import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, baseSkills } from '../../tools/skill-registry.js';
import { SkillLoader, SkillLoaderError } from '../../skills/skill-loader.js';
import type { SkillSpec } from '../../contracts/index.js';

const TOOL_EFFECTS = Object.freeze({
  list_directory: 'read',
  read_file: 'read',
  search_files: 'read',
  edit_file: 'write',
  write_file: 'write',
  execute_command: 'execute',
  parse_document: 'read',
});

function baseSkill(name = 'repository-exploration') {
  return baseSkills().find((skill) => skill.name === name)!;
}

function customSkill(
  name: string,
  changes: Partial<SkillSpec> = {},
): SkillSpec {
  return {
    ...structuredClone(baseSkill()),
    name,
    ...changes,
  } as SkillSpec;
}

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
      2,
      undefined,
      TOOL_EFFECTS,
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
    await expect(loader.activate('repository-exploration')).rejects.toEqual(
      new SkillLoaderError(
        'skill not in frozen snapshot: repository-exploration',
      ),
    );
  });
});

describe('Skill Registry snapshot authority', () => {
  it('hashes nested SkillSpec content recursively', () => {
    const firstSpec = structuredClone(baseSkill());
    const secondSpec = structuredClone(firstSpec);
    secondSpec.failure_policy = { on_failure: 'abort', max_retries: 1 };
    const first = new SkillRegistry();
    const second = new SkillRegistry();
    first.register(firstSpec);
    second.register(secondSpec);

    expect(first.freezeSnapshot().snapshot_id).not.toBe(second.freezeSnapshot().snapshot_id);
  });

  it('clones and deep-freezes nested SkillSpecs', () => {
    const source = structuredClone(baseSkill());
    const registry = new SkillRegistry();
    registry.register(source);
    const registered = registry.getSkill(source.name)!;

    (source.required_tools as string[]).push('execute_command');
    expect(registered.required_tools).not.toContain('execute_command');
    expect(Object.isFrozen(registered.required_tools)).toBe(true);
    expect(() => {
      (registered.required_tools as string[]).push('write_file');
    }).toThrow();
  });

  it('rejects a same-name skill that differs from the frozen version and hash', () => {
    const original = new SkillRegistry();
    original.register(baseSkill());
    const snapshot = original.freezeSnapshot();
    const replacement = new SkillRegistry();
    replacement.register({ ...baseSkill(), version: '2.0.0' });

    expect(replacement.inSnapshot('repository-exploration', snapshot)).toBe(false);
    expect(() => replacement.loadFull('repository-exploration', snapshot)).toThrow(
      'frozen snapshot',
    );
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
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
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
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('repository-exploration');
    expect(result.required_tools_available).toBe(true);
    expect(result.missing_tools).toEqual([]);
    expect(result.risk_ceiling_satisfied).toBe(true);
    expect(result.allowed_effects_verified).toBe(true);
  });

  it('activates with default maxRiskTier of 2', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('repository-exploration');
    expect(result.risk_ceiling_satisfied).toBe(true);
  });

  it('validates allowed_effect_classes', async () => {
    // Base skills use 'read' and 'write' which are in the valid list
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('repository-exploration');
    expect(result.allowed_effects_verified).toBe(true);
  });

  it('loads packaged instructions when no skillsDir is supplied', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('repository-exploration');
    expect(result.instructions).toContain('Inspect the repository');
  });

  it('frozen_version matches skill version', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('repository-exploration');
    expect(result.frozen_version).toBe(result.skill.version);
  });

  it('can activate bug-fix skill with its required tools', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'edit_file', 'execute_command'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('bug-fix');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate feature-implementation skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'write_file', 'edit_file', 'execute_command'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('feature-implementation');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate research-with-citations skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['search_files', 'read_file', 'parse_document'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('research-with-citations');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate document-summary skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['parse_document', 'read_file'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('document-summary');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate writing-refinement skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'write_file'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('writing-refinement');
    expect(result.required_tools_available).toBe(true);
  });

  it('can activate dependency-aware-planning skill', async () => {
    const loader = new SkillLoader(registry, snapshot, ['read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('dependency-aware-planning');
    expect(result.required_tools_available).toBe(true);
  });

  it('rejects skill when maxRiskTier is 0 and risk ceiling is tier_1', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 0);
    await expect(loader.activate('repository-exploration')).rejects.toThrow('risk ceiling');
  });

  it('accepts skill when maxRiskTier equals ceiling', async () => {
    const loader = new SkillLoader(registry, snapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    const result = await loader.activate('repository-exploration');
    expect(result.risk_ceiling_satisfied).toBe(true);
  });

  it('maps named risk tiers instead of treating medium as tier 1', async () => {
    const loader = new SkillLoader(
      registry,
      snapshot,
      ['read_file', 'edit_file', 'execute_command'],
      1,
    );
    await expect(loader.activate('bug-fix')).rejects.toThrow('risk ceiling');
  });

  it('prevents a read-only skill from activating a write-effect tool', async () => {
    const spec = structuredClone(baseSkill());
    spec.name = 'read-only-with-write-tool';
    spec.required_tools = ['edit_file'];
    spec.allowed_effect_classes = ['read'];
    const customRegistry = new SkillRegistry();
    customRegistry.register(spec);
    const loader = new SkillLoader(
      customRegistry,
      customRegistry.freezeSnapshot(),
      ['edit_file'],
      2,
      undefined,
      { edit_file: 'write' },
    );
    await expect(loader.activate(spec.name)).rejects.toThrow(
      'effect write exceeds allowed effects',
    );
  });

  it('rejects an unknown risk ceiling instead of defaulting open', async () => {
    const customSpec = {
      ...baseSkill(),
      name: 'custom-no-risk',
      risk_ceiling: "",
    };
    const customRegistry = new SkillRegistry();
    customRegistry.register(customSpec);
    const customSnapshot = customRegistry.freezeSnapshot();
    const loader = new SkillLoader(customRegistry, customSnapshot, ['list_directory', 'read_file', 'search_files'], 2, undefined, TOOL_EFFECTS);
    await expect(loader.activate('custom-no-risk')).rejects.toThrow(
      'invalid risk ceiling',
    );
  });
});

describe('SkillLoader fail-closed activation contracts', () => {
  function loaderFor(
    spec: SkillSpec,
    options: {
      tools?: string[];
      maxRisk?: number;
      root?: string;
      effects?: Readonly<Record<string, string>>;
    } = {},
  ): SkillLoader {
    const registry = new SkillRegistry();
    registry.register(spec);
    return new SkillLoader(
      registry,
      registry.freezeSnapshot(),
      options.tools ?? (spec.required_tools as string[]),
      options.maxRisk ?? 4,
      options.root,
      options.effects ?? TOOL_EFFECTS,
    );
  }

  it('returns the exact frozen skill, workflow and verification assets', async () => {
    const spec = baseSkill();
    const result = await loaderFor(spec, { maxRisk: 2 }).activate(spec.name);
    expect(result).toMatchObject({
      skill: spec,
      frozen_version: '1.0.0',
      required_tools_available: true,
      missing_tools: [],
      risk_ceiling_satisfied: true,
      allowed_effects_verified: true,
    });
    expect(result.instructions).toContain('Inspect the repository');
    expect(result.verification).toContain('observed_paths_exist');
  });

  it('reports every missing required tool in stable declaration order', async () => {
    const spec = baseSkill();
    await expect(
      loaderFor(spec, { tools: ['read_file'] }).activate(spec.name),
    ).rejects.toThrow(
      "requires tools not available: list_directory, search_files",
    );
  });

  it('rejects a required tool whose effect is absent from the authority map', async () => {
    const spec = baseSkill();
    await expect(
      loaderFor(spec, {
        effects: { list_directory: 'read', read_file: 'read' },
      }).activate(spec.name),
    ).rejects.toThrow(
      'cannot verify effect for required tool: search_files',
    );
  });

  it.each([
    ['low', 1],
    ['medium', 2],
    ['high', 3],
    ['critical', 4],
    ['tier_1', 1],
    ['tier_2', 2],
    ['tier_3', 3],
    ['tier_4', 4],
  ])('accepts risk ceiling %s at exact tier %i', async (risk, tier) => {
    const spec = customSkill(`risk-${risk}`, { risk_ceiling: risk });
    const result = await loaderFor(spec, { maxRisk: tier }).activate(spec.name);
    expect(result.risk_ceiling_satisfied).toBe(true);
  });

  it.each(['', 'tier_0', 'tier_5', '2', 'unknown'])(
    'rejects invalid risk ceiling %j',
    async (risk) => {
      const spec = customSkill(`invalid-risk-${risk || 'empty'}`, {
        risk_ceiling: risk,
      });
      await expect(loaderFor(spec).activate(spec.name)).rejects.toThrow(
        `invalid risk ceiling: ${risk}`,
      );
    },
  );

  it('rejects non-string required tools even when the broad schema accepts the array', async () => {
    const spec = customSkill('invalid-tool-type', {
      required_tools: ['read_file', 42] as unknown[],
    });
    await expect(
      loaderFor(spec, { tools: [], effects: {} }).activate(spec.name),
    ).rejects.toThrow('invalid required_tools');
  });

  it('rejects non-string and unknown allowed effect classes', async () => {
    const nonString = customSkill('invalid-effect-type', {
      allowed_effect_classes: ['read', 42] as unknown[],
    });
    await expect(loaderFor(nonString).activate(nonString.name)).rejects.toThrow(
      'invalid allowed_effect_classes',
    );

    const unknown = customSkill('invalid-effect-name', {
      allowed_effect_classes: ['teleport'],
    });
    await expect(loaderFor(unknown).activate(unknown.name)).rejects.toThrow(
      'invalid allowed_effect_class: teleport',
    );
  });

  it.each([
    ['read_only', 'read'],
    ['idempotent_write', 'write'],
    ['idempotent_write', 'create'],
    ['idempotent_write', 'delete'],
    ['non_idempotent_write', 'write'],
  ])('normalizes %s to permit %s', async (allowed, actual) => {
    const spec = customSkill(`${allowed}-${actual}`, {
      required_tools: ['custom_tool'],
      allowed_effect_classes: [allowed],
    });
    const result = await loaderFor(spec, {
      tools: ['custom_tool'],
      effects: { custom_tool: actual },
    }).activate(spec.name);
    expect(result.allowed_effects_verified).toBe(true);
  });

  it.each([
    'pure',
    'irreversible',
    'read',
    'write',
    'create',
    'delete',
    'execute',
    'publish',
    'communicate',
  ])('permits the exact declared effect %s', async (effect) => {
    const spec = customSkill(`exact-${effect}`, {
      required_tools: ['custom_tool'],
      allowed_effect_classes: [effect],
    });
    const result = await loaderFor(spec, {
      tools: ['custom_tool'],
      effects: { custom_tool: effect },
    }).activate(spec.name);
    expect(result.allowed_effects_verified).toBe(true);
  });

  it('rejects an effect outside the normalized allowlist', async () => {
    const spec = customSkill('read-cannot-publish', {
      required_tools: ['custom_tool'],
      allowed_effect_classes: ['read_only'],
    });
    await expect(
      loaderFor(spec, {
        tools: ['custom_tool'],
        effects: { custom_tool: 'publish' },
      }).activate(spec.name),
    ).rejects.toThrow('effect publish exceeds allowed effects');
  });

  it('loads only assets inside the configured resource root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-assets-'));
    try {
      mkdirSync(join(root, 'workflows'));
      mkdirSync(join(root, 'verifications'));
      writeFileSync(join(root, 'workflows', 'ok.yaml'), 'workflow-body');
      writeFileSync(join(root, 'verifications', 'ok.yaml'), 'verify-body');
      const spec = customSkill('custom-assets', {
        workflow_template_ref: 'workflows/ok.yaml',
        verification_template_ref: 'verifications/ok.yaml',
      });
      const result = await loaderFor(spec, { root }).activate(spec.name);
      expect(result.instructions).toBe('workflow-body');
      expect(result.verification).toBe('verify-body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal and missing packaged assets with typed errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-assets-'));
    try {
      const traversal = customSkill('traversal', {
        workflow_template_ref: '../outside.yaml',
      });
      await expect(
        loaderFor(traversal, { root }).activate(traversal.name),
      ).rejects.toMatchObject({
        name: 'SkillLoaderError',
        message:
          'workflow path escapes packaged resource root: ../outside.yaml',
      });

      const missing = customSkill('missing-asset', {
        workflow_template_ref: 'workflows/missing.yaml',
      });
      await expect(
        loaderFor(missing, { root }).activate(missing.name),
      ).rejects.toBeInstanceOf(SkillLoaderError);
      await expect(
        loaderFor(missing, { root }).activate(missing.name),
      ).rejects.toThrow(
        'workflow asset not found: workflows/missing.yaml',
      );

      const rootEscape = customSkill('root-escape', {
        workflow_template_ref: '..',
      });
      await expect(
        loaderFor(rootEscape, { root }).activate(rootEscape.name),
      ).rejects.toThrow('workflow path escapes packaged resource root: ..');

      mkdirSync(join(root, 'workflows'), { recursive: true });
      writeFileSync(join(root, 'workflows', 'ok.yaml'), 'ok');
      const missingVerification = customSkill('missing-verification', {
        workflow_template_ref: 'workflows/ok.yaml',
        verification_template_ref: 'verifications/missing.yaml',
      });
      await expect(
        loaderFor(missingVerification, { root }).activate(
          missingVerification.name,
        ),
      ).rejects.toThrow(
        'verification asset not found: verifications/missing.yaml',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
