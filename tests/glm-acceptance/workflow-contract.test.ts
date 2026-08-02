import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('manual Phase 1 GLM acceptance workflow', () => {
  it('enforces deterministic, mutation, independent verification, then GLM', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/glm-acceptance.yml'),
      'utf8',
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('expected_sha:');
    expect(workflow).toContain('required: true');
    expect(
      workflow.match(
        /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/gu,
      ),
    ).toHaveLength(4);
    expect(workflow.match(/ref: \$\{\{ github\.sha \}\}/gu)).toHaveLength(4);
    expect(workflow).not.toContain('ref: ${{ inputs.expected_sha }}');
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(4);
    expect(workflow).toContain('[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[[ "$EXPECTED_SHA" == "$WORKFLOW_SHA" ]]');
    expect(workflow).toContain('WORKFLOW_SHA: ${{ github.sha }}');
    expect(workflow).toContain('mutation:\n    needs: deterministic');
    expect(workflow).toContain('verify_mutation:\n    needs: mutation');
    expect(workflow).toContain('acceptance:\n    needs: verify_mutation');
    expect(workflow).toContain('node scripts/run-mutation.mjs phase1');
    expect(workflow.match(/actions\/download-artifact@/gu)).toHaveLength(2);
    expect(workflow.match(/node scripts\/check-mutation-thresholds\.mjs phase1/gu)).toHaveLength(2);
    expect(workflow).toContain('MUTATION_ARTIFACT_DIGEST: ${{ needs.mutation.outputs.artifact_digest }}');
    expect(workflow).toContain(
      'MUTATION_ARTIFACT_DIGEST: ${{ needs.verify_mutation.outputs.artifact_digest }}',
    );
    expect(workflow).toContain(
      'MUTATION_ARTIFACT_NAME: phase1-mutation-${{ github.sha }}',
    );
    expect(workflow).toContain('!reports/mutation/**/*.html');
    expect(workflow).toContain('EXPECTED_SHA: ${{ inputs.expected_sha }}');
    expect(workflow.match(/secrets\.GLM_API_KEY/gu)).toHaveLength(1);
    expect(workflow).toContain('run: npm run build');
    expect(workflow).toContain('run: npm run test:glm:live');
    expect(workflow).not.toContain('run-agent.mjs');
    expect(workflow).toContain(
      'name: glm-acceptance-${{ inputs.expected_sha }}',
    );
    expect(workflow).toContain(
      '${{ runner.temp }}/phase1-evidence/glm-5.2-xhigh-phase1-${{ inputs.expected_sha }}.json',
    );
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v\d/gu);
    for (const reference of workflow.matchAll(/uses:\s+actions\/[^@]+@([^\s]+)/gu)) {
      expect(reference[1]).toMatch(/^[0-9a-f]{40}$/u);
    }
    expect(workflow).not.toMatch(/^(?:env| {4}env):\s*$/mu);
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/mu);
    expect(workflow).not.toMatch(/\b(tag|release)\b/iu);
  });

  it('pins every first-party GitHub Action in Phase 1 workflows to a commit', () => {
    const expectedActions = new Map([
      ['actions/checkout', '11d5960a326750d5838078e36cf38b85af677262'],
      ['actions/setup-node', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
      ['actions/upload-artifact', 'ea165f8d65b6e75b540449e92b4886f43607fa02'],
      ['actions/download-artifact', 'd3f86a106a0bac45b974a628896c90dbdf5c8093'],
    ]);
    for (const file of ['ci.yml', 'mutation.yml', 'glm-acceptance.yml']) {
      const workflow = readFileSync(
        resolve(root, '.github/workflows', file),
        'utf8',
      );
      for (const reference of workflow.matchAll(/uses:\s+(actions\/[^@]+)@([^\s]+)/gu)) {
        expect(reference[2], `${file}: ${reference[1]}`).toBe(
          expectedActions.get(reference[1]!),
        );
      }
      expect(workflow, file).not.toMatch(/uses:\s+actions\/[^@]+@v\d/gu);
      expect(workflow.match(/actions\/checkout@/gu)).toHaveLength(
        workflow.match(/persist-credentials: false/gu)?.length ?? 0,
      );
    }
  });

  it('fetches full history in every workflow job that executes ancestry-sensitive tests or gates', () => {
    const workflowRoot = resolve(root, '.github/workflows');
    const ancestrySensitiveCommand =
      /(?:npm test\b|npm run test:coverage\b|npm run verify:phase2:local\b|node scripts\/gates\/check-phase2-manifest\.mjs\b|vitest run tests\/phase-2\/unit\b)/u;
    const auditedJobs: string[] = [];

    for (const file of readdirSync(workflowRoot).filter((name) =>
      name.endsWith('.yml'),
    )) {
      const workflow = readFileSync(resolve(workflowRoot, file), 'utf8');
      const jobs = workflow.slice(workflow.indexOf('\njobs:') + 6);
      for (const match of jobs.matchAll(
        /^  ([a-zA-Z0-9_-]+):\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|(?![\s\S]))/gmu,
      )) {
        const [, jobName, body = ''] = match;
        if (!ancestrySensitiveCommand.test(body)) continue;
        auditedJobs.push(`${file}:${jobName}`);
        const checkoutBlocks = body
          .split(/(?=^      - uses: actions\/checkout@)/gmu)
          .filter((block) =>
            block.startsWith('      - uses: actions/checkout@'),
          );
        expect(checkoutBlocks, `${file}:${jobName} checkout`).toHaveLength(1);
        expect(checkoutBlocks[0], `${file}:${jobName} history`).toContain(
          'fetch-depth: 0',
        );
        expect(checkoutBlocks[0], `${file}:${jobName} credentials`).toContain(
          'persist-credentials: false',
        );
      }
    }

    expect(auditedJobs.sort()).toEqual([
      'ci.yml:deterministic',
      'glm-acceptance.yml:deterministic',
    ]);
  });
});
