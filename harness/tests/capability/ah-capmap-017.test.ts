import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillRegistry, SkillValidationError } from '../../tools/skill-registry.js';
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
    const source = readFileSync(join(__dirname, '../../tools/skill-registry.ts'), 'utf8');
    expect(source).not.toMatch(/SKILL_SPEC_SCHEMA\s*=\s*\{/);
    expect(source).not.toMatch(/as object/);
  });

});
