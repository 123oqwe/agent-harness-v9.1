/**
 * AH-ROUTER-EVAL-001: exit-criteria assertions for the routing evaluation.
 *
 * Drives the deterministic Router DAG through every task in
 * evals/routing/dataset.json and asserts the frozen phase-3.yaml acceptance
 * criteria:
 *   hard_constraint_violation:    0
 *   routing_regret:               <= 15%
 *   unnecessary_multi_agent_rate: <= 20%
 *   forbidden route selected:     never
 */
import { describe, expect, it } from 'vitest';
import { runRoutingEvaluations } from '../../evals/routing/eval.js';

describe('routing evaluation (AH-ROUTER-EVAL-001)', () => {
  it('every dataset task routes without error', async () => {
    const result = await runRoutingEvaluations();
    expect(result.metrics.total).toBeGreaterThanOrEqual(200);
    expect(result.metrics.routed).toBe(result.metrics.total);
    expect(result.errors).toEqual([]);
  });

  it('hard constraints are never violated', async () => {
    const result = await runRoutingEvaluations();
    expect(result.metrics.hard_constraint_violations).toBe(0);
    const violators = result.task_results.filter((r) => r.hard_constraint_violations.length > 0);
    expect(violators).toEqual([]);
  });

  it('forbidden routes are never selected', async () => {
    const result = await runRoutingEvaluations();
    expect(result.metrics.forbidden_route_selections).toBe(0);
    const violators = result.task_results.filter((r) => r.forbidden_route_violations.length > 0);
    expect(violators).toEqual([]);
  });

  it('routing regret stays at or below the 15% ceiling', async () => {
    const result = await runRoutingEvaluations();
    expect(result.metrics.routing_regret_rate).toBeLessThanOrEqual(0.15);
  });

  it('unnecessary multi-agent routing stays at or below the 20% ceiling', async () => {
    const result = await runRoutingEvaluations();
    expect(result.metrics.unnecessary_multi_agent_rate).toBeLessThanOrEqual(0.2);
  });

  it('reports release-ready when all exit criteria pass', async () => {
    const result = await runRoutingEvaluations();
    expect(result.releaseReady).toBe(true);
    expect(result.metrics.pass).toBe(true);
  });
});
