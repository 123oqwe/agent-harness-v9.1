import { describe, expect, it } from 'vitest';
import type { RunPlan } from '../../contracts/index.js';
import { planActionInstruction } from '../../runtime/plan-execute.js';

type Node = RunPlan['workflow_graph']['nodes'][number];

function node(
  step_id: string,
  step_type: Node['step_type'],
  tool_name?: string,
  status: Node['status'] = 'pending',
): Node {
  return {
    step_id,
    step_type,
    status,
    ...(tool_name === undefined ? {} : { tool_name }),
  } as Node;
}

function plan(
  goal: string,
  tools: Array<{ proposal: string; step: string; tool: string }>,
  extraNodes: Node[] = [],
): RunPlan {
  return {
    task: {
      goal,
      success_criteria: [
        { criterion: 'done', verification_method: 'deterministic' },
      ],
      constraints: [],
    },
    tool_grants: tools.map(({ tool }) => ({ tool, granted: true })),
    workflow_graph: {
      nodes: [
        ...tools.flatMap(({ proposal, step, tool }) => [
          node(proposal, 'model_call'),
          node(step, 'tool_call', tool),
        ]),
        ...extraNodes,
      ],
      edges: tools.map(({ proposal, step }) => ({
        from_step: proposal,
        to_step: step,
      })),
    },
  } as unknown as RunPlan;
}

describe('plan-execute internal validation', () => {
  describe('planActionInstruction edge cases', () => {
    it('returns empty for edit_file when only test paths exist', () => {
      const runPlan = plan(
        'Edit test/sanity.test.ts and fix it.',
        [{ proposal: 'p', step: 'e', tool: 'edit_file' }],
      );
      expect(planActionInstruction(runPlan, 'edit_file', 'e')).toBe(
        ' Edit only "test/sanity.test.ts" using the content returned by the prior read; never edit a test/spec file and never submit a no-op replacement.',
      );
    });

    it('binds edit_file to first non-test source when mixed paths exist', () => {
      const runPlan = plan(
        'Read test/a.test.ts and fix src/app.ts.',
        [
          { proposal: 'p1', step: 'r', tool: 'read_file' },
          { proposal: 'p2', step: 'e', tool: 'edit_file' },
        ],
      );
      const instruction = planActionInstruction(runPlan, 'edit_file', 'e');
      expect(instruction).toContain('"src/app.ts"');
      expect(instruction).not.toContain('test/a.test.ts');
    });

    it('returns empty for write_file when no output path is detected', () => {
      const runPlan = plan(
        'Do something useful.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      expect(planActionInstruction(runPlan, 'write_file', 'w')).toBe('');
    });

    it('binds write_file with planning JSON when depends_on is present', () => {
      const runPlan = plan(
        'Create tasks.json for alpha so every task has id and depends_on array, with beta after alpha.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'write_file', 'w');
      expect(instruction).toContain('"tasks.json"');
      expect(instruction).toContain('alpha');
      expect(instruction).toContain('beta');
    });

    it('binds execute_command with absolute path', () => {
      const runPlan = plan(
        'Run /usr/local/bin/check.sh',
        [{ proposal: 'p', step: 'x', tool: 'execute_command' }],
      );
      const instruction = planActionInstruction(
        runPlan,
        'execute_command',
        'x',
      );
      expect(instruction).toContain('/usr/local/bin/check.sh');
      expect(instruction).toContain('check.sh');
    });

    it('returns empty for execute_command with unknown command', () => {
      const runPlan = plan(
        'Just check things.',
        [{ proposal: 'p', step: 'x', tool: 'execute_command' }],
      );
      expect(planActionInstruction(runPlan, 'execute_command', 'x')).toBe('');
    });

    it('binds read_file with workspace-prefixed path normalization', () => {
      const runPlan = plan(
        'Read /workspace/src/deep/nested/file.ts.',
        [{ proposal: 'p', step: 'r', tool: 'read_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'read_file', 'r');
      expect(instruction).toContain('"src/deep/nested/file.ts"');
      expect(instruction).not.toContain('/workspace/');
    });

    it('binds read_file with relative path without modification', () => {
      const runPlan = plan(
        'Read ./config/settings.json.',
        [{ proposal: 'p', step: 'r', tool: 'read_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'read_file', 'r');
      expect(instruction).toContain('"/config/settings.json"');
    });

    it('returns empty for read_file with root path outside workspace', () => {
      const runPlan = plan(
        'Read /etc/passwd.',
        [{ proposal: 'p', step: 'r', tool: 'read_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'read_file', 'r');
      expect(instruction).toBe('');
    });

    it('binds execute_command with node script containing unicode', () => {
      const runPlan = plan(
        'Run node scripts/检查.mjs',
        [{ proposal: 'p', step: 'x', tool: 'execute_command' }],
      );
      const instruction = planActionInstruction(
        runPlan,
        'execute_command',
        'x',
      );
      expect(instruction).toContain('node');
      expect(instruction).toContain('scripts/检查.mjs');
    });

    it('binds execute_command with python3 script', () => {
      const runPlan = plan(
        'Execute python3 tools/verify.py',
        [{ proposal: 'p', step: 'x', tool: 'execute_command' }],
      );
      const instruction = planActionInstruction(
        runPlan,
        'execute_command',
        'x',
      );
      expect(instruction).toContain('python3');
      expect(instruction).toContain('tools/verify.py');
    });

    it('returns generic JSON contract for non-explicit depends_on', () => {
      const runPlan = plan(
        'Create config.json so everything has id and depends_on fields.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'write_file', 'w');
      expect(instruction).toContain('top-level array');
      expect(instruction).not.toContain('exact structural shape');
    });

    it('binds write path but not JSON contract for non-json target', () => {
      const runPlan = plan(
        'Create plan.txt for build so every task has id and depends_on.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'write_file', 'w');
      expect(instruction).toContain('"plan.txt"');
      expect(instruction).not.toContain('structural shape');
      expect(instruction).not.toContain('top-level array');
    });

    it('binds multiple read_file calls in order', () => {
      const runPlan = plan(
        'Read a.ts then read b.ts then read c.ts.',
        [
          { proposal: 'p1', step: 'r1', tool: 'read_file' },
          { proposal: 'p2', step: 'r2', tool: 'read_file' },
          { proposal: 'p3', step: 'r3', tool: 'read_file' },
        ],
      );
      expect(planActionInstruction(runPlan, 'read_file', 'r1')).toContain(
        '"a.ts"',
      );
      expect(planActionInstruction(runPlan, 'read_file', 'r2')).toContain(
        '"b.ts"',
      );
      expect(planActionInstruction(runPlan, 'read_file', 'r3')).toContain(
        '"c.ts"',
      );
    });

    it('binds write_file with spec file detection', () => {
      const runPlan = plan(
        'Create output.spec.json for data.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'write_file', 'w');
      expect(instruction).toContain('"output.spec.json"');
    });

    it('returns empty for unknown tool type', () => {
      const runPlan = plan(
        'Read src/app.ts.',
        [{ proposal: 'p', step: 's', tool: 'unknown_tool' }],
      );
      expect(planActionInstruction(runPlan, 'unknown_tool', 's')).toBe('');
    });

    it('handles write_file with multiple output paths by picking first', () => {
      const runPlan = plan(
        'Write a.json and create b.json.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      const instruction = planActionInstruction(runPlan, 'write_file', 'w');
      expect(instruction).toContain('"a.json"');
    });
  });
});
