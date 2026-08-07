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
    workflow_graph: {
      nodes: [
        ...tools.map((t) => node(t.proposal, 'model_call')),
        ...tools.map((t) => node(t.step, 'tool_call', t.tool)),
        ...extraNodes,
      ],
      edges: tools.flatMap((t, i) => [
        { from_step: t.proposal, to_step: t.step },
        ...(i > 0 ? [{ from_step: tools[i - 1]!.step, to_step: t.proposal }] : []),
      ]),
    },
    tool_grants: tools.map((t) => ({ tool: t.tool, schema: {} })),
  } as unknown as RunPlan;
}

describe('planActionInstruction - path extraction', () => {
  it('extracts read paths from goal text', () => {
    const rp = plan('Read src/main.ts and fix the bug', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
    ]);
    const instr = planActionInstruction(rp, 'read_file', 's1');
    expect(instr).toContain('main.ts');
  });

  it('extracts write paths from goal text with "write" keyword', () => {
    const rp = plan('Write output/result.json', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('result.json');
  });

  it('extracts write paths from goal text with "create" keyword', () => {
    const rp = plan('Create config/settings.yaml', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('settings.yaml');
  });

  it('extracts write paths from goal text with "into" keyword', () => {
    const rp = plan('Save the data into data/output.csv', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('output.csv');
  });

  it('extracts write paths from goal text with "as" keyword', () => {
    const rp = plan('Save the results as report.md', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('report.md');
  });

  it('returns empty string for read_file when no path in goal', () => {
    const rp = plan('Fix the bug', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
    ]);
    const instr = planActionInstruction(rp, 'read_file', 's1');
    expect(instr).toBe('');
  });

  it('returns empty string for write_file when no output path in goal', () => {
    const rp = plan('Fix the bug', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toBe('');
  });

  it('returns empty string for unknown tool', () => {
    const rp = plan('Do something', [
      { proposal: 'p1', step: 's1', tool: 'unknown_tool' },
    ]);
    const instr = planActionInstruction(rp, 'unknown_tool', 's1');
    expect(instr).toBe('');
  });
});

describe('planActionInstruction - edit_file', () => {
  it('returns instruction with non-test source path', () => {
    const rp = plan('Read src/main.ts and edit it', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
      { proposal: 'p2', step: 's2', tool: 'edit_file' },
    ]);
    const instr = planActionInstruction(rp, 'edit_file', 's2');
    expect(instr).toContain('main.ts');
    expect(instr).toContain('Edit only');
  });

  it('avoids test paths for edit_file when non-test path exists', () => {
    const rp = plan('Read test/foo.test.ts and src/bar.ts then edit', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
      { proposal: 'p2', step: 's2', tool: 'edit_file' },
    ]);
    const instr = planActionInstruction(rp, 'edit_file', 's2');
    expect(instr).toContain('bar.ts');
    expect(instr).not.toContain('test.ts');
  });

  it('falls back to test path for edit_file when only test path exists', () => {
    const rp = plan('Read test/foo.test.ts and edit', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
      { proposal: 'p2', step: 's2', tool: 'edit_file' },
    ]);
    const instr = planActionInstruction(rp, 'edit_file', 's2');
    expect(instr).toContain('test.ts');
  });
});

describe('planActionInstruction - execute_command', () => {
  it('extracts node command from goal', () => {
    const rp = plan('Run node scripts/build.ts', [
      { proposal: 'p1', step: 's1', tool: 'execute_command' },
    ]);
    const instr = planActionInstruction(rp, 'execute_command', 's1');
    expect(instr).toContain('node');
    expect(instr).toContain('build.ts');
  });

  it('extracts python3 command from goal', () => {
    const rp = plan('Execute python3 tools/process.py', [
      { proposal: 'p1', step: 's1', tool: 'execute_command' },
    ]);
    const instr = planActionInstruction(rp, 'execute_command', 's1');
    expect(instr).toContain('python3');
    expect(instr).toContain('process.py');
  });

  it('extracts absolute command path from goal', () => {
    const rp = plan('run /usr/bin/make build', [
      { proposal: 'p1', step: 's1', tool: 'execute_command' },
    ]);
    const instr = planActionInstruction(rp, 'execute_command', 's1');
    expect(instr).toContain('make');
    expect(instr).toContain('build');
  });

  it('returns empty when no command in goal', () => {
    const rp = plan('Do something', [
      { proposal: 'p1', step: 's1', tool: 'execute_command' },
    ]);
    const instr = planActionInstruction(rp, 'execute_command', 's1');
    expect(instr).toBe('');
  });
});

describe('planActionInstruction - write_file with depends_on', () => {
  it('adds planning JSON instruction for .json target with depends_on', () => {
    const rp = plan('Create tasks.json for taskA and taskB so taskA after taskB', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('tasks.json');
    // planningJsonInstruction adds JSON structural shape guidance
    expect(instr).toContain('tasks');
  });

  it('does not add planning JSON instruction for non-json target', () => {
    const rp = plan('Create output.txt with depends_on', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).not.toContain('depends_on');
  });

  it('does not add planning JSON for json without depends_on keyword', () => {
    const rp = plan('Create output.json', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('output.json');
    expect(instr).not.toContain('depends_on');
  });

  it('adds generic JSON instruction when depends_on present but no tasks parsed', () => {
    const rp = plan('Create data.json with depends_on but no task list', [
      { proposal: 'p1', step: 's1', tool: 'write_file' },
    ]);
    const instr = planActionInstruction(rp, 'write_file', 's1');
    expect(instr).toContain('data.json');
    expect(instr).toContain('top-level array');
  });
});

describe('planActionInstruction - workspace path normalization', () => {
  it('normalizes ./ prefix in paths', () => {
    const rp = plan('Read ./src/main.ts', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
    ]);
    const instr = planActionInstruction(rp, 'read_file', 's1');
    expect(instr).toContain('src/main.ts');
    expect(instr).not.toContain('./');
  });

  it('strips /workspace/ prefix from paths', () => {
    const rp = plan('Read /workspace/src/main.ts', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
    ]);
    const instr = planActionInstruction(rp, 'read_file', 's1');
    expect(instr).toContain('src/main.ts');
    expect(instr).not.toContain('/workspace/');
  });

  it('rejects absolute non-workspace paths', () => {
    const rp = plan('Read /etc/passwd and /workspace/src/main.ts', [
      { proposal: 'p1', step: 's1', tool: 'read_file' },
    ]);
    const instr = planActionInstruction(rp, 'read_file', 's1');
    // /etc/passwd should be rejected, only /workspace/src/main.ts should be in sources
    expect(instr).toContain('main.ts');
  });
});
