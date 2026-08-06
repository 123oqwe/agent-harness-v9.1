export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/ui",
  path: "packages/ui",
} as const);

export interface SharedUiPort {
  readonly workspace: typeof workspaceIdentity.name;
}

// AH-UX-STATES-001: Screen state types
export type ScreenState = 'loading' | 'empty' | 'partial' | 'success' | 'error' | 'offline' | 'blocked' | 'approval';

export interface ScreenProps {
  readonly state: ScreenState;
  readonly error?: string;
  readonly data?: unknown;
  readonly onRetry?: () => void;
}

// AH-UX-WEB-001: Phase 2 screen registry
export interface ScreenDefinition {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly states: readonly ScreenState[];
}

export const PHASE2_SCREENS: readonly ScreenDefinition[] = Object.freeze([
  { id: 'doc', title: 'Documents', path: '/documents', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
  { id: 'mm', title: 'Multimodal Studio', path: '/multimodal', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
  { id: 'notify', title: 'Notifications', path: '/notifications', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
  { id: 'planning', title: 'Planning', path: '/planning', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
  { id: 'reconcile', title: 'Reconciliation', path: '/reconcile', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
  { id: 'research', title: 'Research', path: '/research', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
  { id: 'tui', title: 'Terminal', path: '/terminal', states: ['loading', 'success', 'error'] },
  { id: 'writing', title: 'Writing', path: '/writing', states: ['loading', 'empty', 'success', 'error', 'offline', 'blocked', 'approval'] },
]);

// AH-UX-CONTRACT-001: Frontend-backend contract types
export interface ApiContract {
  readonly endpoints: readonly { method: string; path: string; response_type: string }[];
}

export function validateContract(actual: ApiContract, expected: ApiContract): boolean {
  if (actual.endpoints.length !== expected.endpoints.length) return false;
  for (let i = 0; i < expected.endpoints.length; i++) {
    const a = actual.endpoints[i]!;
    const e = expected.endpoints[i]!;
    if (a.method !== e.method || a.path !== e.path) return false;
  }
  return true;
}

// Accessibility check helper
export function checkAccessibility(element: {
  role?: string;
  aria_label?: string;
  aria_description?: string;
  tabindex?: number;
}): string[] {
  const issues: string[] = [];
  if (!element.aria_label && !element.aria_description) {
    issues.push('missing aria-label or aria-description');
  }
  if (element.tabindex === undefined || element.tabindex < 0) {
    issues.push('not keyboard accessible (tabindex missing or negative)');
  }
  return issues;
}
