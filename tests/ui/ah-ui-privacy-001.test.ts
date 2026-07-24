import { describe, expect, it } from 'vitest';
import {
  PrivacyController,
  type PrivacySettings,
  type PrivacyStorePort,
} from '../../ui/ah_ui_privacy_001.js';

function store(): PrivacyStorePort & { state: PrivacySettings } {
  return {
    state: {
      local_only: true,
      data_retention_days: 30,
      consent_log_enabled: true,
    },
    read() { return { ...this.state }; },
    write(settings) { this.state = { ...settings }; return this.read(); },
  };
}

describe('AH-UI-PRIVACY-001 authoritative privacy store', () => {
  it('persists updates through the injected store and exports the real log', () => {
    const backend = store();
    const controller = new PrivacyController(backend, {
      export: () => '{"events":3}',
    });
    controller.update({ data_retention_days: 7 });
    expect(backend.state.data_retention_days).toBe(7);
    expect(controller.exportConsentLog().data).toBe('{"events":3}');
  });

  it('rejects invalid retention before writing', () => {
    const backend = store();
    const controller = new PrivacyController(backend, { export: () => '' });
    expect(controller.update({ data_retention_days: -1 }).state).toBe('error');
    expect(backend.state.data_retention_days).toBe(30);
  });
});
