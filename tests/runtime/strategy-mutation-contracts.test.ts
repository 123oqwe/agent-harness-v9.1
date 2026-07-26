import { describe, expect, it } from 'vitest';
import type { RunPlan } from '../../contracts/index.js';
import {
  planActionInstruction,
} from '../../runtime/plan-execute.js';
import { explicitOutputLimitInstruction } from '../../runtime/react.js';

type Node = RunPlan['workflow_graph']['nodes'][number];

function node(
  step_id: string,
  step_type: Node['step_type'],
  tool_name?: string,
): Node {
  return {
    step_id,
    step_type,
    status: 'pending',
    ...(tool_name === undefined ? {} : { tool_name }),
  } as Node;
}

function plan(
  goal: string,
  tools: Array<{ proposal: string; step: string; tool: string }>,
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
      nodes: tools.flatMap(({ proposal, step, tool }) => [
        node(proposal, 'model_call'),
        node(step, 'tool_call', tool),
      ]),
      edges: tools.map(({ proposal, step }) => ({
        from_step: proposal,
        to_step: step,
      })),
    },
  } as unknown as RunPlan;
}

describe('reasoning strategy mutation contracts', () => {
  describe('explicit output limits', () => {
    it.each([
      ['Answer in at most 1 word.', 1],
      ['Answer in no more than two words.', 2],
      ['Answer in maximum 9999 words.', 9999],
      ['Answer in a maximum of twenty words.', 20],
      ['Answer in at most 10000 words.', 10_000],
    ])('binds the exact English word limit in %s', (goal, limit) => {
      expect(explicitOutputLimitInstruction(goal)).toBe(
        ` The final visible answer must contain at most ${limit} whitespace-separated words.`,
      );
    });

    it.each([
      ['回答不超过1字。', 1],
      ['回答至多 42 个字符。', 42],
      ['回答不超过100000字符。', 100_000],
    ])('binds the exact Chinese character limit in %s', (goal, limit) => {
      expect(explicitOutputLimitInstruction(goal)).toBe(
        ` The final visible answer must contain at most ${limit} characters.`,
      );
    });

    it.each([
      'Answer in at most 0 words.',
      'Answer in at most 10001 words.',
      'Answer in at most many words.',
      '回答不超过0字。',
      '回答至多100001字符。',
      'There is no explicit output limit.',
    ])('rejects an invalid or absent output limit in %s', (goal) => {
      expect(explicitOutputLimitInstruction(goal)).toBe('');
    });
  });

  describe('frozen task action instructions', () => {
    it('binds distinct nested and Unicode read paths by frozen step order', () => {
      const runPlan = plan(
        'Read src/a-1.ts and 资料/值_2.json, then report both.',
        [
          { proposal: 'p1', step: 'r1', tool: 'read_file' },
          { proposal: 'p2', step: 'r2', tool: 'read_file' },
        ],
      );
      expect(planActionInstruction(runPlan, 'read_file', 'r1')).toBe(
        ' The read path must be "src/a-1.ts".',
      );
      expect(planActionInstruction(runPlan, 'read_file', 'r2')).toBe(
        ' The read path must be "资料/值_2.json".',
      );
    });

    it.each([
      ['Write docs/result-1.md with the answer.', 'docs/result-1.md'],
      ['Create output/data_2.json with the result.', 'output/data_2.json'],
      ['Summarize source.txt into nested/summary.md.', 'nested/summary.md'],
      ['Save source.txt as final.txt.', 'final.txt'],
      ['写入 资料/结果.json。', '资料/结果.json'],
      ['创建 output/result.md。', 'output/result.md'],
      ['新建 result.txt。', 'result.txt'],
    ])('binds the exact output path for %s', (goal, target) => {
      const runPlan = plan(goal, [
        { proposal: 'p', step: 'w', tool: 'write_file' },
      ]);
      expect(planActionInstruction(runPlan, 'write_file', 'w')).toBe(
        ` The write path must be ${JSON.stringify(target)}.`,
      );
    });

    it('selects a source file rather than a test/spec file for edits', () => {
      const runPlan = plan(
        'Change src/app.ts and do not edit src/app.test.ts.',
        [{ proposal: 'p', step: 'e', tool: 'edit_file' }],
      );
      expect(planActionInstruction(runPlan, 'edit_file', 'e')).toBe(
        ' Edit only "src/app.ts" using the content returned by the prior read; never edit a test/spec file and never submit a no-op replacement.',
      );
    });

    it.each([
      [
        'Run node scripts/check-1.mjs.',
        ['node', 'scripts/check-1.mjs'],
      ],
      [
        'Execute python3 tools/check_2.py.',
        ['python3', 'tools/check_2.py'],
      ],
      [
        '运行 node scripts/检查.mjs。',
        ['node', 'scripts/检查.mjs'],
      ],
      [
        'Read app.ts, fix it, then run /usr/bin/env true',
        ['/usr/bin/env', 'true'],
      ],
    ])('binds exact command argv for %s', (goal, argv) => {
      const runPlan = plan(goal, [
        { proposal: 'p', step: 'x', tool: 'execute_command' },
      ]);
      expect(planActionInstruction(runPlan, 'execute_command', 'x')).toBe(
        ` Run exactly argv ${JSON.stringify(argv)} with cwd "/workspace"; do not substitute a discovery command.`,
      );
    });

    it('normalizes workspace and relative task paths to the same binding', () => {
      const runPlan = plan(
        'Read /workspace/src/app.ts, then fix src/app.ts.',
        [
          { proposal: 'p1', step: 'r', tool: 'read_file' },
          { proposal: 'p2', step: 'e', tool: 'edit_file' },
        ],
      );
      expect(planActionInstruction(runPlan, 'read_file', 'r')).toContain(
        '"src/app.ts"',
      );
      expect(planActionInstruction(runPlan, 'edit_file', 'e')).toContain(
        '"src/app.ts"',
      );
    });

    it('freezes comma-and dependency grammar into exact JSON', () => {
      const runPlan = plan(
        'Create plan.json for build, test, and deploy so every task has an id and depends_on array, with test after build and deploy after test.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      expect(planActionInstruction(runPlan, 'write_file', 'w')).toBe(
        ' The write path must be "plan.json". The JSON content must have this exact structural shape: {"tasks":[{"id":"build","depends_on":[]},{"id":"test","depends_on":["build"]},{"id":"deploy","depends_on":["test"]}]}.',
      );
    });

    it('emits the generic JSON contract when dependency IDs are not explicit', () => {
      const runPlan = plan(
        'Create plan.json so every item has id and depends_on fields.',
        [{ proposal: 'p', step: 'w', tool: 'write_file' }],
      );
      expect(planActionInstruction(runPlan, 'write_file', 'w')).toBe(
        ' The write path must be "plan.json". The JSON must be a top-level array of task objects, or an object with a tasks array; every task object must have a string id and a depends_on string array.',
      );
    });

    it.each([
      ['read_file', 'Read the workspace without naming a file.'],
      ['write_file', 'Create an artifact without naming a file.'],
      ['execute_command', 'Run the appropriate check.'],
      ['unknown_tool', 'Read src/app.ts.'],
    ])('returns no narrowing when %s has no deterministic binding', (tool, goal) => {
      const runPlan = plan(goal, [
        { proposal: 'p', step: 's', tool },
      ]);
      expect(planActionInstruction(runPlan, tool, 's')).toBe('');
    });
  });
});
