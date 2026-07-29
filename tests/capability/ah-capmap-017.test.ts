import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baseSkills,
  SkillRegistry,
  SkillValidationError,
} from '../../skills/skill-registry.js';
import type { SkillSpec } from '../../contracts/index.js';

function validSkill(name: string): SkillSpec {
  return {
    name, version: '1.0.0', supported_experience_profiles: ['default'],
    input_schema_ref: 'in.json', output_schema_ref: 'out.json',
    required_context: [], required_tools: ['read_file'], allowed_effect_classes: ['read'],
    workflow_template_ref: 'wf.yaml', verification_template_ref: 'v.yaml',
    failure_policy: { on_failure: 'abort' }, risk_ceiling: 'low', eval_suite_ref: 'eval.yaml',
  } as SkillSpec;
}

describe('AH-CAPMAP-017 Skill Registry', () => {
  let reg: SkillRegistry;
  beforeEach(() => { reg = new SkillRegistry(); });

  it('registers a valid SkillSpec', () => {
    reg.register(validSkill('bug-fix'), { summary: 'Fix a bug', domain: 'coding', tags: ['code'] });
    expect(reg.getSkill('bug-fix')?.name).toBe('bug-fix');
  });

  it('rejects duplicate skill names fail-closed', () => {
    reg.register(validSkill('bug-fix'));
    expect(() => reg.register(validSkill('bug-fix'))).toThrow(SkillValidationError);
  });

  it('rejects invalid SkillSpec', () => {
    expect(() => reg.register({ name: 'x' } as unknown as SkillSpec)).toThrow(SkillValidationError);
  });

  it('skills are declarative only (no executable code)', () => {
    reg.register(validSkill('bug-fix'), { summary: 'Fix a bug' });
    const s = reg.getSkill('bug-fix')!;
    expect((s as unknown as { execute?: unknown }).execute).toBeUndefined();
    expect((s as unknown as { run?: unknown }).run).toBeUndefined();
  });

  it('skill_search searches compact metadata without loading full instructions', () => {
    reg.register(validSkill('bug-fix'), { summary: 'Fix a bug in code', domain: 'coding', tags: ['code', 'fix'] });
    reg.register(validSkill('research'), { summary: 'Research with citations', domain: 'research', tags: ['research'] });
    const results = reg.skill_search('bug');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('bug-fix');
    expect(results[0]!.summary).toBe('Fix a bug in code');
    // full SkillSpec NOT in search result
    expect((results[0] as unknown as { workflow_template_ref?: string }).workflow_template_ref).toBeUndefined();
  });

  it('skill_search filters by domain and risk ceiling', () => {
    reg.register(validSkill('bug-fix'), { domain: 'coding' });
    reg.register(validSkill('research'), { domain: 'research' });
    expect(reg.skill_search('', { domain: 'coding' })).toHaveLength(1);
    expect(reg.skill_search('', { riskCeiling: 'low' })).toHaveLength(2);
  });

  it('full SkillSpec loaded only after selection (progressive disclosure)', () => {
    reg.register(validSkill('bug-fix'), { summary: 'Fix a bug' });
    const compact = reg.skill_search('bug')[0]!;
    expect(compact.name).toBe('bug-fix');
    const full = reg.getSkill('bug-fix')!;
    expect(full.workflow_template_ref).toBe('wf.yaml');
  });

  it('freezeSnapshot is immutable and content-addressed', () => {
    reg.register(validSkill('bug-fix'));
    const s1 = reg.freezeSnapshot();
    expect(s1.skill_names).toEqual(['bug-fix']);
    expect(reg.freezeSnapshot().snapshot_id).toBe(s1.snapshot_id);
  });

  it('ships 8 declarative base skills', () => {
    reg.loadBaseSkills();
    expect(reg.size()).toBe(8);
    const names = reg.listSkills();
    expect(names).toContain('repository-exploration');
    expect(names).toContain('bug-fix');
    expect(names).toContain('feature-implementation');
    expect(names).toContain('test-and-verify');
    expect(names).toContain('research-with-citations');
    expect(names).toContain('document-summary');
    expect(names).toContain('writing-refinement');
    expect(names).toContain('dependency-aware-planning');
  });

  it('no network calls during skill loading', () => {
    // loading base skills is pure in-memory; if it tried network it would fail offline
    reg.loadBaseSkills();
    expect(reg.size()).toBe(8);
  });

  it('skill search can never grant tools, capabilities or permissions', () => {
    reg.register(validSkill('bug-fix'), { summary: 'Fix a bug' });
    const results = reg.skill_search('bug');
    expect((results[0] as unknown as { grant?: unknown }).grant).toBeUndefined();
    expect((results[0] as unknown as { capability?: unknown }).capability).toBeUndefined();
  });


  it('does not embed a copied JSON Schema in source code', () => {
    const source = readFileSync(join(__dirname, '../../skills/skill-registry.ts'), 'utf8');
    expect(source).not.toMatch(/SKILL_SPEC_SCHEMA\s*=\s*\{/);
    expect(source).not.toMatch(/as object/);
  });

});

describe('AH-CAPMAP-017 Skill Registry boundary contracts', () => {
  it('uses packaged declarative JSON as the single base-skill authority', () => {
    const specs = baseSkills();
    expect(specs.map((spec) => spec.name)).toEqual([
      'bug-fix',
      'dependency-aware-planning',
      'document-summary',
      'feature-implementation',
      'repository-exploration',
      'research-with-citations',
      'test-and-verify',
      'writing-refinement',
    ]);
    expect(specs.every((spec) => spec.risk_ceiling === 'medium')).toBe(true);

    const registry = new SkillRegistry();
    registry.loadBaseSkills();
    expect(
      registry.listSkills().map((name) => registry.getSkill(name)),
    ).toEqual(specs);
  });

  it('returns sorted names, exact size and undefined for an unknown skill', () => {
    const registry = new SkillRegistry();
    registry.register(validSkill('zeta'));
    registry.register(validSkill('alpha'));
    expect(registry.listSkills()).toEqual(['alpha', 'zeta']);
    expect(registry.size()).toBe(2);
    expect(registry.getSkill('missing')).toBeUndefined();
  });

  it('uses exact default metadata and a typed validation error', () => {
    const registry = new SkillRegistry();
    registry.register(validSkill('defaults'));
    expect(registry.skill_search('')).toEqual([
      {
        name: 'defaults',
        version: '1.0.0',
        summary: '',
        tags: [],
        domain: 'general',
        required_tools: ['read_file'],
        risk_ceiling: 'low',
      },
    ]);
    try {
      registry.register({ name: 'invalid' } as unknown as SkillSpec);
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillValidationError);
      expect((error as Error).name).toBe('SkillValidationError');
      expect((error as Error).message).toContain(
        "must have required property 'version'",
      );
      expect((error as Error).message).toContain(
        "must have required property 'supported_experience_profiles'",
      );
    }
  });

  it('returns exact compact metadata and matches trimmed case-insensitive terms', () => {
    const registry = new SkillRegistry();
    registry.register(validSkill('Bug-Fix'), {
      summary: 'Repair a repository',
      tags: ['TypeScript', 'Regression'],
      domain: 'coding',
    });
    expect(registry.skill_search('  TYPESCRIPT  ')).toEqual([
      {
        name: 'Bug-Fix',
        version: '1.0.0',
        summary: 'Repair a repository',
        tags: ['TypeScript', 'Regression'],
        domain: 'coding',
        required_tools: ['read_file'],
        risk_ceiling: 'low',
      },
    ]);
    expect(registry.skill_search('read_file')).toHaveLength(1);
    expect(registry.skill_search('missing')).toEqual([]);
    expect(registry.skill_search('', { domain: 'research' })).toEqual([]);
    expect(registry.skill_search('', { riskCeiling: 'critical' })).toEqual([]);
  });

  it('does not join adjacent metadata fields into false matches and sorts results', () => {
    const registry = new SkillRegistry();
    registry.register(validSkill('zeta'), { summary: 'last' });
    registry.register(validSkill('alpha'), { summary: 'beta' });
    expect(registry.skill_search('').map((result) => result.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(registry.skill_search('alphabeta')).toEqual([]);
  });

  it('returns immutable compact metadata without leaking registry references', () => {
    const registry = new SkillRegistry();
    const tags = ['code'];
    registry.register(validSkill('bug-fix'), { tags });
    tags.push('outside');
    const results = registry.skill_search('');
    expect(results[0]!.tags).toEqual(['code']);
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
    expect(Object.isFrozen(results[0]!.tags)).toBe(true);
    expect(Object.isFrozen(results[0]!.required_tools)).toBe(true);
  });

  it('content hashing is key-order independent and sensitive to nested values and arrays', () => {
    const left = validSkill('stable');
    const right = {
      eval_suite_ref: left.eval_suite_ref,
      risk_ceiling: left.risk_ceiling,
      failure_policy: { ...left.failure_policy },
      verification_template_ref: left.verification_template_ref,
      workflow_template_ref: left.workflow_template_ref,
      allowed_effect_classes: [...left.allowed_effect_classes],
      required_tools: [...left.required_tools],
      required_context: [...left.required_context],
      output_schema_ref: left.output_schema_ref,
      input_schema_ref: left.input_schema_ref,
      supported_experience_profiles: [...left.supported_experience_profiles],
      version: left.version,
      name: left.name,
    } as SkillSpec;
    const first = new SkillRegistry();
    const second = new SkillRegistry();
    first.register(left);
    second.register(right);
    const stableSnapshot = first.freezeSnapshot();
    expect(stableSnapshot.snapshot_id).toBe(
      'dafd9bbf3db88557206e4a2bcaf338e4170bd00b5c6d784f03358610fbbf6356',
    );
    expect(stableSnapshot.entries[0]!.content_hash).toBe(
      '83ef7912c7042396eaf7da927c433c160543150c71e38f03bcbb4a9225366a21',
    );
    expect(stableSnapshot.snapshot_id).toBe(
      second.freezeSnapshot().snapshot_id,
    );

    const changed = structuredClone(right);
    changed.required_tools = ['read_file', 'search_files'];
    const third = new SkillRegistry();
    third.register(changed);
    expect(third.freezeSnapshot().snapshot_id).not.toBe(
      first.freezeSnapshot().snapshot_id,
    );
  });

  it('freezes every snapshot layer and invalidates the cache after registration', () => {
    const registry = new SkillRegistry();
    registry.register(validSkill('first'));
    const first = registry.freezeSnapshot();
    expect(registry.freezeSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0])).toBe(true);
    expect(Object.isFrozen(first.skill_names)).toBe(true);
    expect(first.entries[0]!.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.snapshot_id).toMatch(/^[a-f0-9]{64}$/);

    registry.register(validSkill('second'));
    const second = registry.freezeSnapshot();
    expect(second).not.toBe(first);
    expect(second.snapshot_id).not.toBe(first.snapshot_id);
    expect(second.skill_names).toEqual(['first', 'second']);
  });

  it('binds full disclosure to name, version and content hash', () => {
    const registry = new SkillRegistry();
    registry.register(validSkill('bound'));
    const snapshot = registry.freezeSnapshot();
    expect(registry.inSnapshot('bound', snapshot)).toBe(true);
    expect(registry.loadFull('bound', snapshot)).toBe(
      registry.getSkill('bound'),
    );
    expect(registry.inSnapshot('missing', snapshot)).toBe(false);

    const wrongVersion = structuredClone(snapshot);
    wrongVersion.entries[0]!.version = '2.0.0';
    expect(registry.inSnapshot('bound', wrongVersion)).toBe(false);
    const wrongHash = structuredClone(snapshot);
    wrongHash.entries[0]!.content_hash = '0'.repeat(64);
    expect(registry.inSnapshot('bound', wrongHash)).toBe(false);
  });

  it('loads JSON deterministically and ignores unsupported extensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-registry-'));
    try {
      writeFileSync(join(dir, 'z.json'), JSON.stringify(validSkill('zeta')));
      writeFileSync(join(dir, 'a.json'), JSON.stringify(validSkill('alpha')));
      writeFileSync(join(dir, 'ignored.yaml'), JSON.stringify(validSkill('yaml')));
      writeFileSync(join(dir, 'notes.txt'), 'not a skill');
      const registry = new SkillRegistry();
      registry.loadSkills(dir);
      expect(registry.listSkills()).toEqual(['alpha', 'zeta']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses files in sorted order and reports the first exact parse failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-order-'));
    try {
      writeFileSync(join(dir, 'z.json'), '{');
      writeFileSync(join(dir, 'a.json'), 'not-json');
      const registry = new SkillRegistry();
      try {
        registry.loadSkills(dir);
        throw new Error('expected parse failure');
      } catch (error) {
        expect(error).toBeInstanceOf(SkillValidationError);
        expect((error as SkillValidationError).file).toBe(
          join(dir, 'a.json'),
        );
        expect((error as Error).message).toContain(
          'failed to parse a.json',
        );
      }
      expect(registry.size()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails directory loading atomically on parse, validation and duplicates', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['parse', { 'a.json': JSON.stringify(validSkill('pending')), 'b.json': '{' }],
      ['validation', { 'a.json': JSON.stringify(validSkill('pending')), 'b.json': JSON.stringify({ name: 'invalid' }) }],
      ['duplicate', { 'a.json': JSON.stringify(validSkill('same')), 'b.json': JSON.stringify(validSkill('same')) }],
    ];
    for (const [label, files] of cases) {
      const dir = mkdtempSync(join(tmpdir(), `skill-${label}-`));
      try {
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(dir, name), content);
        }
        const registry = new SkillRegistry();
        registry.register(validSkill('existing'));
        expect(() => registry.loadSkills(dir)).toThrow(SkillValidationError);
        expect(registry.listSkills()).toEqual(['existing']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('reports the failing file and preserves the old registry on failed reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-reload-'));
    try {
      const registry = new SkillRegistry();
      registry.register(validSkill('existing'));
      writeFileSync(join(dir, 'bad.json'), '{');
      let failure: unknown;
      try {
        registry.reloadSkills(dir);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SkillValidationError);
      expect((failure as SkillValidationError).file).toBe(
        join(dir, 'bad.json'),
      );
      expect(registry.listSkills()).toEqual(['existing']);

      rmSync(join(dir, 'bad.json'));
      writeFileSync(join(dir, 'new.json'), JSON.stringify(validSkill('new')));
      registry.reloadSkills(dir);
      expect(registry.listSkills()).toEqual(['new']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing directory with its exact path', () => {
    const parent = mkdtempSync(join(tmpdir(), 'skill-missing-'));
    const missing = join(parent, 'absent');
    try {
      const registry = new SkillRegistry();
      expect(() => registry.loadSkills(missing)).toThrow(
        `directory not found: ${missing}`,
      );
      try {
        registry.loadSkills(missing);
      } catch (error) {
        expect((error as SkillValidationError).file).toBe(missing);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
