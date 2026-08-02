import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('manual Phase 1 GLM acceptance workflow', () => {
  it('checks out the requested SHA and scopes the model secret to acceptance only', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/glm-acceptance.yml'),
      'utf8',
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('expected_sha:');
    expect(workflow).toContain('required: true');
    expect(workflow).toContain(
      "if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).not.toContain('ref: ${{ inputs.expected_sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[[ "$EXPECTED_SHA" == "$WORKFLOW_SHA" ]]');
    expect(workflow).toContain('WORKFLOW_SHA: ${{ github.sha }}');
    expect(workflow).toContain('EXPECTED_SHA: ${{ inputs.expected_sha }}');
    expect(workflow.match(/secrets\.GLM_API_KEY/gu)).toHaveLength(1);
    expect(workflow).toContain('run: npm run build');
    expect(workflow).toContain('run: npm run test:glm:live');
    expect(workflow).toContain(
      'name: glm-acceptance-${{ inputs.expected_sha }}',
    );
    expect(workflow).toContain(
      'reports/acceptance/glm-5.2-xhigh-phase1-${{ inputs.expected_sha }}.json',
    );
    expect(workflow).not.toMatch(/^(?:env| {4}env):\s*$/mu);
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/mu);
    expect(workflow).not.toMatch(/\b(tag|release)\b/iu);
  });
});
