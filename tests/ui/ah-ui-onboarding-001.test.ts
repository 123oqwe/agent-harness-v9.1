import { describe, expect, it, vi } from 'vitest';
import { OnboardingController } from '../../ui/ah_ui_onboarding_001.js';

function controller() {
  const authority = {
    authenticate: vi.fn((token: string) => token === 'valid-token'),
    acceptPolicy: vi.fn((accepted: boolean) => accepted),
  };
  return { controller: new OnboardingController(authority), authority };
}

describe('AH-UI-ONBOARDING-001 authority-backed onboarding', () => {
  it('requires external authentication and policy acceptance', () => {
    const { controller: value, authority } = controller();
    value.advance();
    expect(value.advance('invalid')).toMatchObject({ state: 'error' });
    expect(value.advance('valid-token').state).toBe('success');
    expect(value.advance()).toMatchObject({
      state: 'approval',
      approval_required: true,
    });
    expect(value.advance(undefined, true).state).toBe('success');
    value.advance();
    expect(value.isComplete()).toBe(true);
    expect(authority.authenticate).toHaveBeenCalledWith('valid-token');
  });

  it('never stores or returns the authentication token', () => {
    const { controller: value } = controller();
    value.advance();
    const result = value.advance('valid-token');
    expect(JSON.stringify(result)).not.toContain('valid-token');
  });
});
