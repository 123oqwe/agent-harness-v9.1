/** AH-UI-SETTINGS-001: Settings screen with real config (provider, risk ceiling, budget). */
import type { UiResult } from './ui-state.js';

export interface Settings { provider: string; risk_ceiling: string; max_budget_usd: number; local_only: boolean }
export class SettingsController {
  private settings: Settings = { provider: 'scripted_test', risk_ceiling: 'medium', max_budget_usd: 5, local_only: true };
  get(): UiResult<Settings> { return { state: 'success', data: { ...this.settings } }; }
  update(patch: Partial<Settings>): UiResult<Settings> {
    if (patch.max_budget_usd !== undefined && patch.max_budget_usd < 0) return { state: 'error', error: 'budget must be >= 0' };
    this.settings = { ...this.settings, ...patch };
    return { state: 'success', data: { ...this.settings } };
  }
  reset(): UiResult<Settings> { this.settings = { provider: 'scripted_test', risk_ceiling: 'medium', max_budget_usd: 5, local_only: true }; return this.get(); }
}
