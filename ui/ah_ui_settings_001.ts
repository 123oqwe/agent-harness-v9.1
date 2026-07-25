/** AH-UI-SETTINGS-001: Settings screen with real config (provider, risk ceiling, budget). */
import type { UiResult } from './ui-state.js';

export interface Settings { provider: string; risk_ceiling: string; max_budget_usd: number; local_only: boolean }
export interface SettingsStorePort {
  read(): Settings;
  write(settings: Settings): Settings;
  reset(): Settings;
}

export class SettingsController {
  constructor(private readonly store: SettingsStorePort) {}

  get(): UiResult<Settings> {
    return { state: 'success', data: { ...this.store.read() } };
  }
  update(patch: Partial<Settings>): UiResult<Settings> {
    if (
      patch.max_budget_usd !== undefined &&
      (!Number.isFinite(patch.max_budget_usd) ||
        patch.max_budget_usd < 0)
    ) {
      return {
        state: 'error',
        error: 'budget must be a finite non-negative number',
      };
    }
    const settings = this.store.write({ ...this.store.read(), ...patch });
    return { state: 'success', data: { ...settings } };
  }
  reset(): UiResult<Settings> {
    return { state: 'success', data: { ...this.store.reset() } };
  }
}
