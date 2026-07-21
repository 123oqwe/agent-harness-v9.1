// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { SettingsController } from '../../ui/ah_ui_settings_001.js';
describe('AH-UI-SETTINGS-001 settings', () => {
  it('returns real config', () => { const c = new SettingsController(); expect(c.get().data!.provider).toBe('scripted_test'); });
  it('updates config', () => { const c = new SettingsController(); c.update({ risk_ceiling: 'high' }); expect(c.get().data!.risk_ceiling).toBe('high'); });
  it('rejects negative budget', () => { const c = new SettingsController(); expect(c.update({ max_budget_usd: -1 }).state).toBe('error'); });
  it('reset restores defaults', () => { const c = new SettingsController(); c.update({ risk_ceiling: 'high' }); c.reset(); expect(c.get().data!.risk_ceiling).toBe('medium'); });
});
