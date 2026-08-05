/**
 * AH-RUNTIME-005: Health Monitor (P1-07)
 *
 * Registers health checks for model_backend, tool_execution, memory_store.
 * API server /health returns real status.
 */
export type HealthState = 'healthy' | 'degraded' | 'down';

export interface HealthCheck {
  name: string;
  check: () => HealthState;
}

export interface HealthReport {
  overall: HealthState;
  components: { name: string; state: HealthState }[];
  timestamp: string;
}

export class HealthMonitor {
  private readonly checks = new Map<string, HealthCheck>();

  register(name: string, check: () => HealthState): void {
    this.checks.set(name, { name, check });
  }

  checkAll(): HealthReport {
    const components: { name: string; state: HealthState }[] = [];
    let overall: HealthState = 'healthy';

    for (const [name, check] of this.checks) {
      const state = check.check();
      components.push({ name, state });
      if (state === 'down') overall = 'down';
      else if (state === 'degraded' && overall !== 'down') overall = 'degraded';
    }

    return { overall, components, timestamp: new Date().toISOString() };
  }

  getComponentNames(): string[] { return [...this.checks.keys()]; }
}
