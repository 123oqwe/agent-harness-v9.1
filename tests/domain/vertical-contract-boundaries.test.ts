import { describe, expect, it, vi } from 'vitest';
import type { Harness, HarnessOutcome } from '../../harness.js';
import {
  codingTaskContract,
  runCodingVertical,
} from '../../domains/coding/ah_coding_vertical_001.js';
import {
  docTaskContract,
  runDocVertical,
} from '../../domains/documents/ah_doc_vertical_001.js';
import {
  paTaskContract,
  runPAVertical,
} from '../../domains/personal-assistant/ah_pa_vertical_001.js';
import {
  PlanningInputError,
  planningTaskContract,
  runPlanningVertical,
} from '../../domains/planning/ah_planning_vertical_001.js';
import {
  researchTaskContract,
  runResearchVertical,
} from '../../domains/research/ah_research_vertical_001.js';
import {
  runWritingVertical,
  writingTaskContract,
} from '../../domains/writing/ah_writing_vertical_001.js';

function outcome(
  overrides: Record<string, unknown> = {},
): HarnessOutcome {
  return {
    success: true,
    loop_result: {
      turns: [],
    },
    evidence: {
      workspace_changes: [],
      tool_calls: [],
      audit_entries: [],
    },
    ...overrides,
  } as unknown as HarnessOutcome;
}

function fakeHarness(result: HarnessOutcome): {
  harness: Harness;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => result);
  return {
    harness: { run } as unknown as Harness,
    run,
  };
}

describe('Phase 1 vertical contracts and evidence boundaries', () => {
  it('freezes the exact coding task contract and delegates it once', async () => {
    const input = {
      repo_path: '/workspace',
      bug_file: '/workspace/src/add.ts',
      test_command: ['npm', 'test', '--', 'add'],
    };
    const task = codingTaskContract(input);
    expect(task).toEqual({
      goal:
        'Read the file /workspace/src/add.ts, locate the bug, fix it, then run npm test -- add',
      success_criteria: [
        {
          criterion: 'bug file read and bug located',
          verification_method: 'deterministic',
        },
        {
          criterion: 'fix applied to file',
          verification_method: 'deterministic',
        },
        { criterion: 'tests pass', verification_method: 'test' },
        {
          criterion: 'diff generated',
          verification_method: 'deterministic',
        },
      ],
      constraints: [
        {
          type: 'tool_restriction',
          value: 'read_file,edit_file,execute_command',
        },
        { type: 'privacy', value: 'local_only' },
      ],
    });
    const result = outcome();
    const fake = fakeHarness(result);
    const output = await runCodingVertical(fake.harness, input);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(fake.run.mock.calls[0]![0]).toEqual(task);
    expect(fake.run.mock.calls[0]![1]).toMatch(/^coding-\d+$/u);
    expect(output).toEqual({
      read_ok: false,
      fix_applied: false,
      test_exit_code: null,
      diff_before: '',
      diff_after: '',
      bug_located: false,
      outcome: result,
    });
  });

  it('derives coding success only from matching read/edit/test receipts and a real diff', async () => {
    const input = {
      repo_path: '/workspace',
      bug_file: '/workspace/bug.ts',
      test_command: ['npm', 'test'],
    };
    const result = outcome({
      loop_result: {
        turns: [
          {
            tool_observations: [
              {
                name: 'read_file',
                status: 'ok',
                result: {
                  path: '/workspace/other.ts',
                  content: 'wrong',
                  truncated: false,
                },
              },
              {
                name: 'read_file',
                status: 'ok',
                result: {
                  path: '/workspace/bug.ts',
                  content: 'bug location',
                  truncated: false,
                },
              },
              {
                name: 'edit_file',
                status: 'ok',
                result: {
                  path: '/workspace/bug.ts',
                  replacements: 2,
                },
              },
              {
                name: 'execute_command',
                status: 'ok',
                arguments: {
                  argv: ['npm', 'test'],
                  cwd: '/workspace',
                },
                result: { exit_code: 0, timed_out: false },
              },
            ],
          },
        ],
      },
      evidence: {
        workspace_changes: [
          {
            path: '/workspace/bug.ts',
            before_sha256: 'before',
            after_sha256: 'after',
          },
        ],
        tool_calls: [],
        audit_entries: [],
      },
    });
    const output = await runCodingVertical(
      fakeHarness(result).harness,
      input,
    );
    expect(output).toMatchObject({
      read_ok: true,
      fix_applied: true,
      test_exit_code: 0,
      diff_before: 'before',
      diff_after: 'after',
      bug_located: true,
    });
  });

  it.each([
    {
      read: { content: 'bug', truncated: true },
      edit: { replacements: 1 },
      before: 'a',
      after: 'b',
      expected: {
        read_ok: false,
        fix_applied: true,
        bug_located: true,
      },
    },
    {
      read: { content: '', truncated: false },
      edit: { replacements: 0 },
      before: 'same',
      after: 'same',
      expected: {
        read_ok: true,
        fix_applied: false,
        bug_located: false,
      },
    },
  ])('fails closed for incomplete coding evidence %#', async (fixture) => {
    const result = outcome({
      loop_result: {
        turns: [
          {
            tool_observations: [
              {
                name: 'read_file',
                status: 'ok',
                result: { path: '/workspace/bug.ts', ...fixture.read },
              },
              {
                name: 'edit_file',
                status: 'ok',
                result: { path: '/workspace/bug.ts', ...fixture.edit },
              },
              {
                name: 'execute_command',
                status: 'ok',
                arguments: {
                  argv: ['wrong'],
                  cwd: '/wrong',
                },
                result: { exit_code: 0 },
              },
            ],
          },
        ],
      },
      evidence: {
        workspace_changes: [
          {
            path: '/workspace/bug.ts',
            before_sha256: fixture.before,
            after_sha256: fixture.after,
          },
        ],
        tool_calls: [],
        audit_entries: [],
      },
    });
    const output = await runCodingVertical(fakeHarness(result).harness, {
      repo_path: '/workspace',
      bug_file: '/workspace/bug.ts',
      test_command: ['npm', 'test'],
    });
    expect(output).toMatchObject({
      ...fixture.expected,
      test_exit_code: null,
    });
  });

  it('rejects coding receipts with the wrong tool, status, path, or missing result', async () => {
    const result = outcome({
      loop_result: {
        turns: [
          {
            tool_observations: [
              {
                name: 'write_file',
                status: 'ok',
                result: {
                  path: '/workspace/bug.ts',
                  content: 'poison',
                },
              },
              {
                name: 'read_file',
                status: 'error',
                result: {
                  path: '/workspace/bug.ts',
                  content: 'poison',
                },
              },
              {
                name: 'read_file',
                status: 'ok',
                result: {
                  path: '/workspace/other.ts',
                  content: 'poison',
                },
              },
              {
                name: 'edit_file',
                status: 'error',
                result: {
                  path: '/workspace/bug.ts',
                  replacements: 5,
                },
              },
              {
                name: 'execute_command',
                status: 'error',
                arguments: {
                  argv: ['npm', 'test'],
                  cwd: '/workspace',
                },
                result: { exit_code: 0 },
              },
            ],
          },
        ],
      },
      evidence: {
        workspace_changes: [
          {
            path: '/workspace/other.ts',
            before_sha256: 'before',
            after_sha256: 'after',
          },
        ],
        tool_calls: [],
        audit_entries: [],
      },
    });
    const output = await runCodingVertical(
      fakeHarness(result).harness,
      {
        repo_path: '/workspace',
        bug_file: '/workspace/bug.ts',
        test_command: ['npm', 'test'],
      },
    );
    expect(output).toMatchObject({
      read_ok: false,
      fix_applied: false,
      test_exit_code: null,
      diff_before: '',
      diff_after: '',
      bug_located: false,
    });
  });

  it('requires both a successful edit receipt and a changed workspace hash', async () => {
    const baseTurn = {
      tool_observations: [
        {
          name: 'read_file',
          status: 'ok',
          result: {
            path: '/workspace/bug.ts',
            content: 'bug',
            truncated: false,
          },
        },
      ],
    };
    const input = {
      repo_path: '/workspace',
      bug_file: '/workspace/bug.ts',
      test_command: ['npm', 'test'],
    };
    const diffWithoutEdit = outcome({
      loop_result: { turns: [baseTurn] },
      evidence: {
        workspace_changes: [
          {
            path: '/workspace/bug.ts',
            before_sha256: 'before',
            after_sha256: 'after',
          },
        ],
        tool_calls: [],
        audit_entries: [],
      },
    });
    expect(
      await runCodingVertical(
        fakeHarness(diffWithoutEdit).harness,
        input,
      ),
    ).toMatchObject({
      read_ok: true,
      fix_applied: false,
      bug_located: false,
    });

    const editWithoutDiff = outcome({
      loop_result: {
        turns: [
          {
            tool_observations: [
              ...baseTurn.tool_observations,
              {
                name: 'edit_file',
                status: 'ok',
                result: {
                  path: '/workspace/bug.ts',
                  replacements: 1,
                },
              },
            ],
          },
        ],
      },
      evidence: {
        workspace_changes: [],
        tool_calls: [],
        audit_entries: [],
      },
    });
    expect(
      await runCodingVertical(
        fakeHarness(editWithoutDiff).harness,
        input,
      ),
    ).toMatchObject({
      read_ok: true,
      fix_applied: false,
      bug_located: true,
      diff_before: '',
      diff_after: '',
    });
  });

  it('does not accept an empty read result as coding proof', async () => {
    const result = outcome({
      loop_result: {
        turns: [
          {
            tool_observations: [
              {
                name: 'read_file',
                status: 'ok',
                result: { path: '/workspace/bug.ts' },
              },
            ],
          },
        ],
      },
    });
    const output = await runCodingVertical(
      fakeHarness(result).harness,
      {
        repo_path: '/workspace',
        bug_file: '/workspace/bug.ts',
        test_command: ['npm', 'test'],
      },
    );
    expect(output.read_ok).toBe(false);
    expect(output.bug_located).toBe(false);
  });

  it('freezes the document contract and filters citations from parsed evidence', async () => {
    const input = { path: '/workspace/report.pdf', max_pages: 3 };
    expect(docTaskContract(input)).toEqual({
      goal:
        'Read document at /workspace/report.pdf, extract text, summarize content, cite page numbers',
      success_criteria: [
        {
          criterion: 'document parsed and text extracted',
          verification_method: 'deterministic',
        },
        {
          criterion: 'summary mentions key content',
          verification_method: 'semantic',
        },
        {
          criterion: 'citations reference correct page numbers',
          verification_method: 'deterministic',
        },
      ],
      constraints: [{ type: 'privacy', value: 'local_only' }],
    });
    const text = `  ${'x'.repeat(140)}  `;
    const result = outcome({
      loop_result: {
        turns: [
          {
            model: { content: 'first' },
            tool_observations: [
              {
                name: 'parse_document',
                status: 'ok',
                result: {
                  path: '/workspace/report.pdf',
                  pages: [
                    { page: 0, text: 'invalid page' },
                    { page: 1.5, text: 'invalid integer' },
                    { page: 2, text: 9 },
                    { page: 3, text },
                  ],
                },
              },
            ],
          },
          { model: { content: 'final summary' }, tool_observations: [] },
        ],
      },
    });
    const fake = fakeHarness(result);
    const output = await runDocVertical(fake.harness, input);
    expect(fake.run.mock.calls[0]![0]).toEqual(docTaskContract(input));
    expect(fake.run.mock.calls[0]![1]).toMatch(/^doc-\d+$/u);
    expect(output.summary).toBe('final summary');
    expect(output.citations).toEqual([
      { page: 3, excerpt: 'x'.repeat(120) },
    ]);
  });

  it('returns empty document evidence when no matching successful parse exists', async () => {
    for (const toolObservation of [
      undefined,
      {
        name: 'parse_document',
        status: 'error',
        result: { path: '/workspace/doc.txt', pages: [] },
      },
      {
        name: 'parse_document',
        status: 'ok',
        result: { path: '/workspace/other.txt', pages: [] },
      },
    ]) {
      const result = outcome({
        loop_result: {
          turns:
            toolObservation === undefined
              ? []
              : [{ model: { content: '' }, tool_observations: [toolObservation] }],
        },
      });
      const output = await runDocVertical(fakeHarness(result).harness, {
        path: '/workspace/doc.txt',
      });
      expect(output).toMatchObject({ summary: '', citations: [] });
    }
  });

  it('freezes the personal-assistant contract and stable priority schedule', async () => {
    const input = {
      tasks: [
        { id: 'L', title: 'low', priority: 'low' as const, duration_min: 5 },
        { id: 'H1', title: 'high one', priority: 'high' as const, duration_min: 10 },
        { id: 'H2', title: 'high two', priority: 'high' as const, duration_min: 0 },
        { id: 'N', title: 'normal', priority: 'normal' as const, duration_min: 10 },
        { id: 'NEG', title: 'invalid', priority: 'high' as const, duration_min: -1 },
      ],
      available_minutes: 20,
    };
    expect(paTaskContract(input)).toEqual({
      goal:
        'Schedule tasks for 20 minutes. Tasks: L: low (low, 5min), H1: high one (high, 10min), H2: high two (high, 0min), N: normal (normal, 10min), NEG: invalid (high, -1min)',
      success_criteria: [
        {
          criterion: 'all tasks scheduled or unallocated with reason',
          verification_method: 'deterministic',
        },
        {
          criterion: 'no external actions (no email/calendar/push/sms)',
          verification_method: 'deterministic',
        },
        {
          criterion: 'high priority tasks first',
          verification_method: 'deterministic',
        },
      ],
      constraints: [
        { type: 'privacy', value: 'local_only' },
        { type: 'tool_restriction', value: 'no_external_write' },
      ],
    });
    const result = outcome();
    const fake = fakeHarness(result);
    const output = await runPAVertical(fake.harness, input);
    expect(fake.run.mock.calls[0]![1]).toMatch(/^pa-\d+$/u);
    expect(output.plan).toEqual([
      { task_id: 'H1', title: 'high one', slot: 0 },
      { task_id: 'H2', title: 'high two', slot: 10 },
      { task_id: 'N', title: 'normal', slot: 10 },
    ]);
    expect(output.unallocated).toEqual(['NEG', 'L']);
    expect(output.no_external_actions).toBe(true);
  });

  it.each([
    {
      evidence: {
        workspace_changes: [],
        tool_calls: [{ tool: 'send_email' }],
        audit_entries: [],
      },
    },
    {
      evidence: {
        workspace_changes: [],
        tool_calls: [],
        audit_entries: [
          { tool_name: 'calendar.write', verdict: 'allow' },
        ],
      },
    },
  ])('detects an allowed external personal-assistant effect %#', async ({ evidence }) => {
    const output = await runPAVertical(
      fakeHarness(outcome({ evidence })).harness,
      { tasks: [], available_minutes: 0 },
    );
    expect(output.no_external_actions).toBe(false);
  });

  it('ignores denied or malformed external audit entries', async () => {
    const output = await runPAVertical(
      fakeHarness(
        outcome({
          evidence: {
            workspace_changes: [],
            tool_calls: [{ tool: 'read_file' }],
            audit_entries: [
              { tool_name: 'send_email', verdict: 'deny' },
              { tool_name: 4, verdict: 'allow' },
            ],
          },
        }),
      ).harness,
      { tasks: [], available_minutes: 0 },
    );
    expect(output.no_external_actions).toBe(true);
  });

  it('freezes planning validation errors and the exact task contract', () => {
    const error = new PlanningInputError('boundary');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PlanningInputError');
    expect(error.message).toBe('boundary');
    for (const id of ['', ' ']) {
      expect(() =>
        planningTaskContract({
          goal: 'x',
          tasks: [{ id, depends_on: [] }],
        }),
      ).toThrow('task IDs must be non-empty and unique');
    }
    expect(() =>
      planningTaskContract({
        goal: 'x',
        tasks: [
          { id: 'a', depends_on: [] },
          { id: 'a', depends_on: [] },
        ],
      }),
    ).toThrow('task IDs must be non-empty and unique');
    expect(() =>
      planningTaskContract({
        goal: 'x',
        tasks: [
          { id: 'a', depends_on: ['x'] },
          { id: 'b', depends_on: ['y'] },
        ],
      }),
    ).toThrow('unknown dependencies: a->x, b->y');

    expect(
      planningTaskContract({
        goal: 'ship',
        tasks: [
          { id: 'build', depends_on: [] },
          { id: 'test', depends_on: ['build'] },
        ],
      }),
    ).toEqual({
      goal:
        'Create a plan for: ship. Tasks: build (depends: none); test (depends: build)',
      success_criteria: [
        {
          criterion: 'plan includes all tasks',
          verification_method: 'deterministic',
        },
        {
          criterion: 'plan has no dependency cycles',
          verification_method: 'deterministic',
        },
        {
          criterion: 'plan is feasible',
          verification_method: 'deterministic',
        },
      ],
      constraints: [
        { type: 'budget', value: '0' },
        { type: 'time', value: '1 week' },
      ],
    });
  });

  it('topologically sorts a branching plan and binds feasibility to outcome success', async () => {
    const input = {
      goal: 'ship',
      tasks: [
        { id: 'build', depends_on: [] },
        { id: 'lint', depends_on: ['build'] },
        { id: 'test', depends_on: ['build'] },
        { id: 'deploy', depends_on: ['lint', 'test'] },
      ],
    };
    for (const success of [true, false]) {
      const result = outcome({ success });
      const fake = fakeHarness(result);
      const output = await runPlanningVertical(fake.harness, input);
      expect(fake.run.mock.calls[0]![0]).toEqual(
        planningTaskContract(input),
      );
      expect(fake.run.mock.calls[0]![1]).toMatch(/^planning-\d+$/u);
      expect(output).toMatchObject({
        plan: ['build', 'lint', 'test', 'deploy'],
        valid: true,
        cycles: [],
        feasible: success,
        outcome: result,
      });
    }
  });

  it.each([
    {
      tasks: [{ id: 'a', depends_on: ['a'] }],
      cycle: ['a', 'a'],
    },
    {
      tasks: [
        { id: 'a', depends_on: ['b'] },
        { id: 'b', depends_on: ['c'] },
        { id: 'c', depends_on: ['a'] },
      ],
      cycle: ['a', 'b', 'c', 'a'],
    },
  ])('returns exact cycle evidence and no plan %#', async ({ tasks, cycle }) => {
    const output = await runPlanningVertical(
      fakeHarness(outcome()).harness,
      { goal: 'cycle', tasks },
    );
    expect(output.plan).toEqual([]);
    expect(output.valid).toBe(false);
    expect(output.feasible).toBe(false);
    expect(output.cycles).toContainEqual(cycle);
  });

  it('freezes the research contract and derives only source-bound evidence', async () => {
    const input = {
      sources: ['/workspace/a.txt', '/workspace/b.txt', '/workspace/c.txt'],
      query: 'Needle',
    };
    expect(researchTaskContract(input)).toEqual({
      goal:
        'Research query "Needle" using sources: /workspace/a.txt, /workspace/b.txt, /workspace/c.txt. Organize evidence, identify conflicts, cite sources.',
      success_criteria: [
        {
          criterion: 'all sources read',
          verification_method: 'deterministic',
        },
        {
          criterion: 'evidence organized with citations',
          verification_method: 'deterministic',
        },
        {
          criterion: 'conflicts identified',
          verification_method: 'semantic',
        },
        {
          criterion: 'report is coherent',
          verification_method: 'semantic',
        },
      ],
      constraints: [{ type: 'privacy', value: 'local_only' }],
    });
    const prefix = 'p'.repeat(60);
    const result = outcome({
      loop_result: {
        turns: [
          {
            model: { content: 'intermediate' },
            tool_observations: [
              {
                name: 'read_file',
                status: 'ok',
                result: {
                  path: '/workspace/a.txt',
                  content: `${prefix}NEEDLE${'s'.repeat(120)}`,
                },
              },
              {
                name: 'read_file',
                status: 'error',
                result: {
                  path: '/workspace/b.txt',
                  content: 'Needle ignored',
                },
              },
              {
                name: 'read_file',
                status: 'ok',
                result: {
                  path: '/workspace/c.txt',
                  content: 'no match',
                },
              },
            ],
          },
          { model: { content: 'final report' }, tool_observations: [] },
        ],
      },
      verification_report: {
        records: [
          {
            evidence: {
              conflicts: ['conflict-a', 4, 'conflict-b'],
            },
          },
          { evidence: { conflicts: 'not-an-array' } },
        ],
      },
    });
    const fake = fakeHarness(result);
    const output = await runResearchVertical(fake.harness, input);
    expect(fake.run.mock.calls[0]![1]).toMatch(/^research-\d+$/u);
    expect(output.evidence).toEqual([
      {
        source: '/workspace/a.txt',
        excerpt: `${'p'.repeat(50)}NEEDLE${'s'.repeat(94)}`,
      },
    ]);
    expect(output.citations).toEqual(['/workspace/a.txt']);
    expect(output.conflicts).toEqual(['conflict-a', 'conflict-b']);
    expect(output.report).toBe('final report');
  });

  it('returns empty research output without matching observations or verifier records', async () => {
    const result = outcome();
    const output = await runResearchVertical(
      fakeHarness(result).harness,
      { sources: ['/workspace/a.txt'], query: 'needle' },
    );
    expect(output).toMatchObject({
      evidence: [],
      conflicts: [],
      report: '',
      citations: [],
      outcome: result,
    });
  });

  it('freezes the writing contract and derives self-check from verifier records', async () => {
    const input = {
      brief: 'Explain the harness',
      requirements: ['title', 'security'],
    };
    expect(writingTaskContract(input)).toEqual({
      goal:
        'Compose a draft based on brief: Explain the harness. Requirements: title, security',
      success_criteria: [
        { criterion: 'title', verification_method: 'semantic' },
        { criterion: 'security', verification_method: 'semantic' },
      ],
      constraints: [{ type: 'privacy', value: 'local_only' }],
    });
    const result = outcome({
      loop_result: {
        turns: [{ model: { content: 'draft-v1' }, tool_observations: [] }],
      },
      verification_report: {
        records: [
          { criterion: 'title', status: 'passed' },
          { criterion: 'security', status: 'failed' },
        ],
      },
    });
    const fake = fakeHarness(result);
    const output = await runWritingVertical(fake.harness, input);
    expect(fake.run.mock.calls[0]![1]).toMatch(/^writing-\d+$/u);
    expect(output).toEqual({
      draft: 'draft-v1',
      self_check: [
        { requirement: 'title', met: true },
        { requirement: 'security', met: false },
      ],
      output:
        'draft-v1\n\n[WARNING: some requirements may need further work]',
      outcome: result,
    });
  });

  it('returns an unmodified draft only when every writing requirement passes', async () => {
    const result = outcome({
      loop_result: {
        turns: [{ model: { content: 'complete' }, tool_observations: [] }],
      },
      verification_report: {
        records: [
          { criterion: 'a', status: 'passed' },
          { criterion: 'b', status: 'passed' },
        ],
      },
    });
    const output = await runWritingVertical(
      fakeHarness(result).harness,
      { brief: 'x', requirements: ['a', 'b'] },
    );
    expect(output).toMatchObject({
      draft: 'complete',
      self_check: [
        { requirement: 'a', met: true },
        { requirement: 'b', met: true },
      ],
      output: 'complete',
    });
  });

  it('fails writing self-check closed when no model or verifier proof exists', async () => {
    const output = await runWritingVertical(
      fakeHarness(outcome()).harness,
      { brief: 'x', requirements: ['must-have'] },
    );
    expect(output).toMatchObject({
      draft: '',
      self_check: [{ requirement: 'must-have', met: false }],
      output:
        '\n\n[WARNING: some requirements may need further work]',
    });
  });
});
