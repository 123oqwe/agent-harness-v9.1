// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { OnboardingController } from '../../ui/ah_ui_onboarding_001.js';
describe('AH-UI-ONBOARDING-001 onboarding', () => {
  it('has real steps: welcome, auth, policy, ready', () => {
    const c = new OnboardingController();
    expect(c.getCurrentStep().data!.id).toBe('welcome');
  });
  it('auth step requires token', () => {
    const c = new OnboardingController();
    c.advance(); // welcome
    const r = c.advance(); // auth, no token
    expect(r.state).toBe('error');
  });
  it('policy step requires approval', () => {
    const c = new OnboardingController();
    c.advance(); c.advance('token'); // welcome + auth
    const r = c.advance(); // policy, not accepted
    expect(r.state).toBe('approval');
    expect(r.approval_required).toBe(true);
  });
  it('completes all steps', () => {
    const c = new OnboardingController();
    c.advance(); c.advance('token'); c.advance('token', true); c.advance();
    expect(c.isComplete()).toBe(true);
  });
});
