import { describe, it, expect } from 'vitest';
import { routeDag, PIPELINE_STAGE_NAMES, type PipelineObserver } from '../../router/pipeline.js';
import { profileIntent } from '../../router/static-router.js';
import { setupDeps, DEFAULT_IDENTITY, task } from './pipeline-setup.js';

interface StageRecord {
  stage: string;
  startedAt: number;
  endedAt: number;
}

function recordingObserver(records: StageRecord[]): PipelineObserver {
  return {
    onStageComplete(stage, startedAt, endedAt) {
      records.push({ stage, startedAt, endedAt });
    },
  };
}

describe('AH-ROUTER-DAG-001 strict sequential ordering', () => {
  it('runs exactly the 14 mandated stages in order', async () => {
    const records: StageRecord[] = [];
    const deps = setupDeps();
    const r = await routeDag(task('fix the bug then run the tests then verify'), DEFAULT_IDENTITY, deps, {
      observer: recordingObserver(records),
    });
    expect(r.outcome).toBe('route');
    expect(records.map((rec) => rec.stage)).toEqual(PIPELINE_STAGE_NAMES);
    expect(records).toHaveLength(PIPELINE_STAGE_NAMES.length);
  });

  it('never overlaps stage intervals — no Promise.all parallelism', async () => {
    const records: StageRecord[] = [];
    const deps = setupDeps();
    await routeDag(task('fix the bug then run the tests then verify'), DEFAULT_IDENTITY, deps, {
      observer: recordingObserver(records),
    });
    for (let i = 1; i < records.length; i += 1) {
      const prev = records[i - 1]!;
      const curr = records[i]!;
      expect(curr.startedAt).toBeGreaterThanOrEqual(prev.endedAt);
    }
  });

  it('fires the observer for the stage that raises a veto, then stops', async () => {
    const records: StageRecord[] = [];
    const deps = setupDeps();
    const r = await routeDag(
      task('write notes.txt', { constraints: [{ type: 'risk_ceiling', value: 'read_only' }] }),
      DEFAULT_IDENTITY,
      deps,
      { observer: recordingObserver(records) },
    );
    expect(r.outcome).toBe('abstain');
    // Identity/Policy, Profiler, Domain/Experience, Context/Capability recorded.
    expect(records.map((rec) => rec.stage)).toEqual(PIPELINE_STAGE_NAMES.slice(0, 4));
  });

  it('the optional taskProfiler is the only stage that may be async', async () => {
    const order: string[] = [];
    const deps = setupDeps();
    const r = await routeDag(task('fix the bug then run the tests'), DEFAULT_IDENTITY, deps, {
      observer: { onStageComplete: (stage) => order.push(stage) },
      taskProfiler: async (t) => {
        // A real LLM profiler would await a model here; only Identity/Policy
        // may have completed before it.
        expect(order).toEqual(['Identity/Policy']);
        return profileIntent(t);
      },
    });
    expect(r.outcome).toBe('route');
    expect(order).toEqual(PIPELINE_STAGE_NAMES);
  });
});
