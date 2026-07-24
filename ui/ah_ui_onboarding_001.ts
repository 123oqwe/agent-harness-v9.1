/** AH-UI-ONBOARDING-001: Onboarding flow with real steps (auth + policy acceptance). */
import type { UiResult } from './ui-state.js';

export interface OnboardingStep { id: string; title: string; completed: boolean }
export interface OnboardingState { steps: OnboardingStep[]; current_step: number }
export interface OnboardingAuthorityPort {
  authenticate(token: string): boolean;
  acceptPolicy(accepted: boolean): boolean;
}

export class OnboardingController {
  private state: OnboardingState = { steps: [
    { id: 'welcome', title: 'Welcome', completed: false },
    { id: 'auth', title: 'Authenticate', completed: false },
    { id: 'policy', title: 'Accept Privacy Policy', completed: false },
    { id: 'ready', title: 'Ready to Start', completed: false },
  ], current_step: 0 };

  constructor(private readonly authority: OnboardingAuthorityPort) {}

  getCurrentStep(): UiResult<OnboardingStep> {
    return { state: 'success', data: this.state.steps[this.state.current_step] };
  }
  advance(authToken?: string, policyAccepted?: boolean): UiResult<OnboardingState> {
    const step = this.state.steps[this.state.current_step];
    if (!step) return { state: 'error', error: 'no more steps' };
    if (
      step.id === 'auth' &&
      (!authToken || !this.authority.authenticate(authToken))
    ) {
      return { state: 'error', error: 'authentication failed' };
    }
    if (
      step.id === 'policy' &&
      !this.authority.acceptPolicy(policyAccepted === true)
    ) {
      return { state: 'approval', approval_required: true };
    }
    step.completed = true;
    this.state.current_step++;
    return { state: this.state.current_step >= this.state.steps.length ? 'success' : 'success', data: this.state };
  }
  isComplete(): boolean { return this.state.current_step >= this.state.steps.length; }
}
