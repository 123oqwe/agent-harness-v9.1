import { describe, it, expect } from 'vitest';
import { ConsentService, deriveConsentLevel, consentRequired } from '../../security/consent.js';

describe('Consent Service', () => {
  it('derives correct consent level from risk tier', () => {
    expect(deriveConsentLevel(0)).toBe('none');
    expect(deriveConsentLevel(1)).toBe('none');
    expect(deriveConsentLevel(2)).toBe('session_confirm');
    expect(deriveConsentLevel(3)).toBe('session_confirm_preview');
    expect(deriveConsentLevel(4)).toBe('recent_password');
    expect(deriveConsentLevel(5)).toBe('webauthn');
  });

  it('consent required only for tier >= 2', () => {
    expect(consentRequired(0)).toBe(false);
    expect(consentRequired(1)).toBe(false);
    expect(consentRequired(2)).toBe(true);
    expect(consentRequired(5)).toBe(true);
  });

  it('auto-approves tier 0-1 without handler', async () => {
    const svc = new ConsentService();
    const result = await svc.request({ tool_name: 'read_file', risk_tier: 0 });
    expect(result.granted).toBe(true);
    expect(result.level).toBe('none');
  });

  it('denies tier 2+ without handler', async () => {
    const svc = new ConsentService();
    const result = await svc.request({ tool_name: 'write_file', risk_tier: 2 });
    expect(result.granted).toBe(false);
  });

  it('auto-approves specific tools when added to allowlist', async () => {
    const svc = new ConsentService();
    svc.allowAutoApprove('execute_command');
    const result = await svc.request({ tool_name: 'execute_command', risk_tier: 3 });
    expect(result.granted).toBe(true);
  });

  it('calls handler for tier 2+ consent', async () => {
    const svc = new ConsentService(async (req) => ({
      granted: true,
      level: deriveConsentLevel(req.risk_tier),
      timestamp: new Date().toISOString(),
    }));
    const result = await svc.request({ tool_name: 'write_file', risk_tier: 2 });
    expect(result.granted).toBe(true);
    expect(result.level).toBe('session_confirm');
  });
});
