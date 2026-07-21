/** AH-UI-ONBOARDING-001: Onboarding flow with real steps (auth + policy acceptance). */
// @ts-nocheck

import type { UiResult } from './ui-state.js';
import type { Policy } from '../security/policy-engine.js';

export interface OnboardingStep { id: string; title: string; completed: boolean }
export interface OnboardingState { steps: OnboardingStep[]; current_step: number; auth_token?: string }

export class OnboardingController {
  private state: OnboardingState = { steps: [
    { id: 'welcome', title: 'Welcome', completed: false },
    { id: 'auth', title: 'Authenticate', completed: false },
    { id: 'policy', title: 'Accept Privacy Policy', completed: false },
    { id: 'ready', title: 'Ready to Start', completed: false },
  ], current_step: 0 };

  getCurrentStep(): UiResult<OnboardingStep> {
    return { state: 'success', data: this.state.steps[this.state.current_step] };
  }
  advance(authToken?: string, policyAccepted?: boolean): UiResult<OnboardingState> {
    const step = this.state.steps[this.state.current_step];
    if (!step) return { state: 'error', error: 'no more steps' };
    if (step.id === 'auth' && !authToken) return { state: 'error', error: 'auth token required' };
    if (step.id === 'policy' && !policyAccepted) return { state: 'approval', approval_required: true };
    step.completed = true;
    this.state.current_step++;
    if (this.state.auth_token === undefined && authToken) this.state.auth_token = authToken;
    return { state: this.state.current_step >= this.state.steps.length ? 'success' : 'success', data: this.state };
  }
  isComplete(): boolean { return this.state.current_step >= this.state.steps.length; }
}
