import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('AH-GLM-001: GLM acceptance client structure', () => {
  it('glm-cases.json exists and contains valid cases', () => {
    const raw = readFileSync(join(__dirname, 'glm-cases.json'), 'utf8');
    const cases = JSON.parse(raw);
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBe(11);
  });

  it('every case has required fields (id, category, prompt)', () => {
    const raw = readFileSync(join(__dirname, 'glm-cases.json'), 'utf8');
    const cases = JSON.parse(raw);
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(c.category).toBeTruthy();
      expect(c.prompt).toBeTruthy();
    }
  });

  it('cases do NOT contain expected_pass (answers not revealed to model)', () => {
    const raw = readFileSync(join(__dirname, 'glm-cases.json'), 'utf8');
    const cases = JSON.parse(raw);
    for (const c of cases) {
      expect(c).not.toHaveProperty('expected_pass');
    }
  });

  it('all 9 categories are represented', () => {
    const raw = readFileSync(join(__dirname, 'glm-cases.json'), 'utf8');
    const cases = JSON.parse(raw);
    const categories = new Set(cases.map((c: { category: string }) => c.category));
    expect(categories.has('normal')).toBe(true);
    expect(categories.has('boundary')).toBe(true);
    expect(categories.has('adversarial')).toBe(true);
    expect(categories.has('permission_bypass')).toBe(true);
    expect(categories.has('prompt_injection')).toBe(true);
    expect(categories.has('tool_poisoning')).toBe(true);
    expect(categories.has('sandbox_escape')).toBe(true);
    expect(categories.has('crash_recovery')).toBe(true);
    expect(categories.has('cross_task_contamination')).toBe(true);
  });

  it('glm-result.schema.json requires any_case_failed and actual_test_summary', () => {
    const raw = readFileSync(join(__dirname, 'glm-result.schema.json'), 'utf8');
    const schema = JSON.parse(raw);
    expect(schema.required).toContain('any_case_failed');
    expect(schema.required).toContain('actual_test_summary');
    expect(schema.required).toContain('unresolved_high_findings');
    expect(schema.required).toContain('unresolved_critical_findings');
  });

  it('runGlmAcceptance throws when GLM_API_KEY is not set', async () => {
    const { runGlmAcceptance } = await import('../../verification/glm-acceptance.js');
    const savedKey = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    try {
      await expect(runGlmAcceptance()).rejects.toThrow(/GLM_API_KEY not set.*fail closed/);
    } finally {
      if (savedKey) process.env.GLM_API_KEY = savedKey;
    }
  });

  it('case IDs are unique', () => {
    const raw = readFileSync(join(__dirname, 'glm-cases.json'), 'utf8');
    const cases = JSON.parse(raw);
    const ids = cases.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
