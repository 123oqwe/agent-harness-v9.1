import { describe, expect, it } from 'vitest';
import {
  SettingsController,
  type Settings,
  type SettingsStorePort,
} from '../../ui/ah_ui_settings_001.js';

function store(): SettingsStorePort & { state: Settings } {
  const value = {
    state: {
      provider: 'scripted',
      risk_ceiling: 'medium',
      max_budget_usd: 5,
      local_only: true,
    },
    read() { return { ...this.state }; },
    write(settings: Settings) { this.state = { ...settings }; return this.read(); },
    reset() {
      this.state = {
        provider: 'scripted',
        risk_ceiling: 'medium',
        max_budget_usd: 5,
        local_only: true,
      };
      return this.read();
    },
  };
  return value;
}

describe('AH-UI-SETTINGS-001 authoritative settings store', () => {
  it('reads, updates, and resets the injected store', () => {
    const backend = store();
    const controller = new SettingsController(backend);
    expect(controller.get().data!.provider).toBe('scripted');
    controller.update({ risk_ceiling: 'high' });
    expect(backend.state.risk_ceiling).toBe('high');
    expect(controller.reset().data!.risk_ceiling).toBe('medium');
  });

  it('rejects negative budgets before touching the store', () => {
    const backend = store();
    const controller = new SettingsController(backend);
    expect(controller.update({ max_budget_usd: -1 }).state).toBe('error');
    expect(backend.state.max_budget_usd).toBe(5);
  });
});
