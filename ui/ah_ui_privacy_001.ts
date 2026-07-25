/** AH-UI-PRIVACY-001: Privacy center with real data controls. */
import type { UiResult } from './ui-state.js';

export interface PrivacySettings { local_only: boolean; data_retention_days: number; consent_log_enabled: boolean }
export interface PrivacyStorePort {
  read(): PrivacySettings;
  write(settings: PrivacySettings): PrivacySettings;
}
export interface ConsentLogPort {
  export(): string;
}

export class PrivacyController {
  constructor(
    private readonly store: PrivacyStorePort,
    private readonly consentLog: ConsentLogPort,
  ) {}

  get(): UiResult<PrivacySettings> {
    return { state: 'success', data: { ...this.store.read() } };
  }
  update(patch: Partial<PrivacySettings>): UiResult<PrivacySettings> {
    if (
      patch.data_retention_days !== undefined &&
      (!Number.isSafeInteger(patch.data_retention_days) ||
        patch.data_retention_days < 0)
    ) {
      return {
        state: 'error',
        error: 'retention must be a non-negative integer',
      };
    }
    const settings = this.store.write({ ...this.store.read(), ...patch });
    return { state: 'success', data: { ...settings } };
  }
  exportConsentLog(): UiResult<string> {
    return { state: 'success', data: this.consentLog.export() };
  }
}
