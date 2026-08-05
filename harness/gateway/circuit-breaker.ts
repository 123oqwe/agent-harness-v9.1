export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  readonly provider: string;
  failureThreshold: number;
  recoveryTimeout: number;
  state: CircuitState = 'closed';
  consecutiveFailures = 0;
  lastFailureTime = 0;
  private halfOpenProbeInFlight = false;

  constructor(provider: string, failureThreshold = 5, recoveryTimeout = 60_000) {
    this.provider = provider;
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
  }

  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeout) {
        this.state = 'half_open';
        this.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }
    // half_open
    if (!this.halfOpenProbeInFlight) {
      this.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.halfOpenProbeInFlight = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = Date.now();
    this.halfOpenProbeInFlight = false;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}
