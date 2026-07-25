import { describe, expect, it, vi } from 'vitest';
import type { TaskContract } from '../../contracts/index.js';
import type { Harness, HarnessOutcome } from '../../harness.js';
import {
  ApprovalController,
  type ApprovalAuthorityPort,
} from '../../ui/ah_ui_approval_001.js';
import { ChatController } from '../../ui/ah_ui_chat_001.js';
import { CodingWorkspaceController } from '../../ui/ah_ui_coding_001.js';
import { EvidenceViewerController } from '../../ui/ah_ui_evidence_001.js';
import {
  OnboardingController,
  type OnboardingAuthorityPort,
} from '../../ui/ah_ui_onboarding_001.js';
import {
  PrivacyController,
  type PrivacySettings,
  type PrivacyStorePort,
} from '../../ui/ah_ui_privacy_001.js';
import {
  SettingsController,
  type Settings,
  type SettingsStorePort,
} from '../../ui/ah_ui_settings_001.js';
import {
  TaskController,
  type Task,
  type TaskRuntimePort,
} from '../../ui/ah_ui_task_001.js';

function harnessOutcome(
  success: boolean,
  content = 'verified reply',
): HarnessOutcome {
  return {
    success,
    loop_result: {
      termination_reason: success
        ? 'goal_satisfied'
        : 'verification_failed',
      turns:
        content === ''
          ? []
          : [
              {
                model: { content },
                tool_observations: [],
              },
            ],
    },
    evidence: {
      workspace_changes: [],
      tool_calls: [],
      audit_entries: [],
    },
  } as unknown as HarnessOutcome;
}

describe('Phase 1 UI adapter state boundaries', () => {
  it('projects exact empty approval state and rejection fallback', () => {
    const decide = vi.fn(() => ({ accepted: false }));
    const authority: ApprovalAuthorityPort = {
      listPending: () => [],
      decide,
    };
    const controller = new ApprovalController(authority);
    expect(controller.list()).toEqual({
      state: 'empty',
      data: [],
      approval_required: false,
    });
    expect(controller.decide('missing', 'denied')).toEqual({
      state: 'error',
      error: 'decision rejected',
    });
    expect(decide).toHaveBeenCalledWith('missing', 'denied');
  });

  it('builds an exact trimmed chat task, monotonic run IDs, and timestamped transcript', async () => {
    const run = vi.fn(
      async (_task: TaskContract, _runId?: string) =>
        harnessOutcome(true),
    );
    const timestamps = ['user-1', 'assistant-1', 'user-2', 'assistant-2'];
    const controller = new ChatController(
      { run } as never,
      () => timestamps.shift()!,
    );
    expect(controller.list()).toEqual({ state: 'empty', data: [] });
    expect(await controller.send('  hello  ')).toEqual({
      state: 'success',
      data: {
        role: 'assistant',
        content: 'verified reply',
        timestamp: 'assistant-1',
      },
    });
    expect(await controller.send('next')).toMatchObject({
      state: 'success',
    });
    expect(run.mock.calls).toEqual([
      [
        {
          goal: 'hello',
          success_criteria: [
            {
              criterion: 'answer addresses the user request',
              verification_method: 'semantic',
            },
          ],
          constraints: [],
        },
        'chat-1',
      ],
      [
        {
          goal: 'next',
          success_criteria: [
            {
              criterion: 'answer addresses the user request',
              verification_method: 'semantic',
            },
          ],
          constraints: [],
        },
        'chat-2',
      ],
    ]);
    expect(controller.list()).toEqual({
      state: 'success',
      data: [
        { role: 'user', content: '  hello  ', timestamp: 'user-1' },
        {
          role: 'assistant',
          content: 'verified reply',
          timestamp: 'assistant-1',
        },
        { role: 'user', content: 'next', timestamp: 'user-2' },
        {
          role: 'assistant',
          content: 'verified reply',
          timestamp: 'assistant-2',
        },
      ],
    });
  });

  it('exposes loading only while chat Harness execution is pending', async () => {
    let release!: (value: HarnessOutcome) => void;
    const pending = new Promise<HarnessOutcome>((resolve) => {
      release = resolve;
    });
    const controller = new ChatController({
      run: async () => pending,
    } as never);
    const send = controller.send('wait');
    expect(controller.isLoading()).toBe(true);
    release(harnessOutcome(true));
    await expect(send).resolves.toMatchObject({ state: 'success' });
    expect(controller.isLoading()).toBe(false);
  });

  it('fails chat closed for empty verified replies, failed runs, and non-Error throws', async () => {
    const empty = new ChatController({
      run: async () => harnessOutcome(true, ''),
    } as never);
    await expect(empty.send('empty')).resolves.toEqual({
      state: 'error',
      error: 'verified reply is empty',
    });
    expect(empty.list().data).toHaveLength(1);

    const failed = new ChatController({
      run: async () => harnessOutcome(false, 'unverified claim'),
    } as never);
    await expect(failed.send('fail')).resolves.toEqual({
      state: 'error',
      error: 'Harness run failed: verification_failed',
    });
    expect(failed.isLoading()).toBe(false);

    const unavailable = new ChatController({
      run: async () => {
        throw 'offline';
      },
    } as never);
    await expect(unavailable.send('fail')).resolves.toEqual({
      state: 'error',
      error: 'chat unavailable',
    });
  });

  it('returns exact coding UI error projections for failed outcomes and exceptions', async () => {
    const failedOutcome = harnessOutcome(false);
    const failed = new CodingWorkspaceController({
      run: async () => failedOutcome,
    } as unknown as Harness);
    const input = {
      repo_path: '/workspace',
      bug_file: '/workspace/bug.ts',
      test_command: ['npm', 'test'],
    };
    const failedResult = await failed.runFix(input);
    expect(failedResult).toMatchObject({
      state: 'error',
      error: 'Harness run failed: verification_failed',
      data: {
        read_ok: false,
        fix_applied: false,
        test_exit_code: null,
        outcome: failedOutcome,
      },
    });

    for (const [thrown, message] of [
      [new Error('runtime unavailable'), 'runtime unavailable'],
      ['offline', 'coding workspace unavailable'],
    ] as const) {
      const controller = new CodingWorkspaceController({
        run: async () => {
          throw thrown;
        },
      } as unknown as Harness);
      await expect(controller.runFix(input)).resolves.toEqual({
        state: 'error',
        error: message,
      });
    }
  });

  it('normalizes non-Error evidence authority failures', () => {
    const controller = new EvidenceViewerController({
      listSummaries: () => {
        throw 'offline';
      },
    });
    expect(controller.list()).toEqual({
      state: 'error',
      error: 'evidence unavailable',
    });
  });

  it('projects every onboarding step, authority decision, completion, and terminal state', () => {
    const authority: OnboardingAuthorityPort = {
      authenticate: vi.fn((token) => token === 'valid'),
      acceptPolicy: vi.fn((accepted) => accepted),
    };
    const controller = new OnboardingController(authority);
    expect(controller.getCurrentStep()).toEqual({
      state: 'success',
      data: { id: 'welcome', title: 'Welcome', completed: false },
    });
    const welcome = controller.advance();
    expect(welcome.state).toBe('success');
    expect(welcome.data?.current_step).toBe(1);
    expect(welcome.data?.steps[0]).toEqual({
      id: 'welcome',
      title: 'Welcome',
      completed: true,
    });
    expect(controller.getCurrentStep().data).toEqual({
      id: 'auth',
      title: 'Authenticate',
      completed: false,
    });
    expect(controller.advance()).toEqual({
      state: 'error',
      error: 'authentication failed',
    });
    expect(controller.advance('invalid')).toEqual({
      state: 'error',
      error: 'authentication failed',
    });
    expect(controller.advance('valid').state).toBe('success');
    expect(authority.authenticate).toHaveBeenCalledWith('valid');
    expect(controller.getCurrentStep().data?.id).toBe('policy');
    expect(controller.advance(undefined, false)).toEqual({
      state: 'approval',
      approval_required: true,
    });
    expect(authority.acceptPolicy).toHaveBeenCalledWith(false);
    expect(controller.advance(undefined, true).state).toBe('success');
    expect(controller.advance().state).toBe('success');
    expect(controller.isComplete()).toBe(true);
    expect(controller.getCurrentStep()).toEqual({ state: 'empty' });
    expect(controller.advance()).toEqual({
      state: 'error',
      error: 'no more steps',
    });
  });

  it('reads, merges, validates, and exports exact privacy authority state', () => {
    const state: PrivacySettings = {
      local_only: true,
      data_retention_days: 30,
      consent_log_enabled: true,
    };
    const store: PrivacyStorePort = {
      read: vi.fn(() => ({ ...state })),
      write: vi.fn((settings) => {
        Object.assign(state, settings);
        return { ...state };
      }),
    };
    const exportLog = vi.fn(() => '{"events":2}');
    const controller = new PrivacyController(store, {
      export: exportLog,
    });
    expect(controller.get()).toEqual({ state: 'success', data: state });
    expect(controller.update({ local_only: false })).toEqual({
      state: 'success',
      data: { ...state, local_only: false },
    });
    expect(store.write).toHaveBeenCalledWith({
      local_only: false,
      data_retention_days: 30,
      consent_log_enabled: true,
    });
    expect(controller.update({ data_retention_days: 0 }).state).toBe(
      'success',
    );
    for (const invalid of [-1, 1.5, Number.NaN]) {
      expect(
        controller.update({ data_retention_days: invalid }),
      ).toEqual({
        state: 'error',
        error: 'retention must be a non-negative integer',
      });
    }
    expect(controller.exportConsentLog()).toEqual({
      state: 'success',
      data: '{"events":2}',
    });
    expect(exportLog).toHaveBeenCalledOnce();
  });

  it('reads, merges, validates, and resets exact settings authority state', () => {
    let state: Settings = {
      provider: 'glm',
      risk_ceiling: 'medium',
      max_budget_usd: 5,
      local_only: true,
    };
    const defaults = { ...state };
    const store: SettingsStorePort = {
      read: vi.fn(() => ({ ...state })),
      write: vi.fn((settings) => {
        state = { ...settings };
        return { ...state };
      }),
      reset: vi.fn(() => {
        state = { ...defaults };
        return { ...state };
      }),
    };
    const controller = new SettingsController(store);
    expect(controller.get()).toEqual({ state: 'success', data: defaults });
    expect(controller.update({ risk_ceiling: 'high' })).toEqual({
      state: 'success',
      data: { ...defaults, risk_ceiling: 'high' },
    });
    expect(store.write).toHaveBeenCalledWith({
      ...defaults,
      risk_ceiling: 'high',
    });
    expect(controller.update({ max_budget_usd: 0 }).state).toBe('success');
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(controller.update({ max_budget_usd: invalid })).toEqual({
        state: 'error',
        error: 'budget must be a finite non-negative number',
      });
    }
    expect(controller.reset()).toEqual({
      state: 'success',
      data: defaults,
    });
  });

  it('trims task goals, preserves optional strategy, and projects empty/success runtime state', () => {
    const tasks: Task[] = [];
    const runtime: TaskRuntimePort = {
      submit: vi.fn((goal, strategy) => {
        const task: Task = {
          id: `task-${tasks.length + 1}`,
          goal,
          status: 'pending',
          ...(strategy === undefined ? {} : { strategy }),
        };
        tasks.push(task);
        return task;
      }),
      list: vi.fn(() => tasks),
    };
    const controller = new TaskController(runtime);
    expect(controller.list()).toEqual({ state: 'empty', data: [] });
    expect(controller.create('  fix bug  ', 'plan_execute')).toEqual({
      state: 'success',
      data: {
        id: 'task-1',
        goal: 'fix bug',
        status: 'pending',
        strategy: 'plan_execute',
      },
    });
    expect(runtime.submit).toHaveBeenCalledWith(
      'fix bug',
      'plan_execute',
    );
    expect(controller.list()).toEqual({
      state: 'success',
      data: [
        {
          id: 'task-1',
          goal: 'fix bug',
          status: 'pending',
          strategy: 'plan_execute',
        },
      ],
    });
    expect(controller.create('  ')).toEqual({
      state: 'error',
      error: 'goal required',
    });
  });
});
