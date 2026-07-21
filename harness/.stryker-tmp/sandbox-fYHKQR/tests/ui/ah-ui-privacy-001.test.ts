// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { PrivacyController } from '../../ui/ah_ui_privacy_001.js';
describe('AH-UI-PRIVACY-001 privacy center', () => {
  it('returns real privacy settings', () => { const c = new PrivacyController(); expect(c.get().data!.local_only).toBe(true); });
  it('updates settings', () => { const c = new PrivacyController(); c.update({ data_retention_days: 7 }); expect(c.get().data!.data_retention_days).toBe(7); });
  it('rejects negative retention', () => { const c = new PrivacyController(); expect(c.update({ data_retention_days: -1 }).state).toBe('error'); });
  it('exports consent log', () => { const c = new PrivacyController(); const r = c.exportConsentLog(); expect(r.state).toBe('success'); expect(r.data).toContain('local_only'); });
});
