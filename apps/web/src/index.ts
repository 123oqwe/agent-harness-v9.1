export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-web",
  path: "apps/web",
} as const);

export interface WebCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}

// AH-UX-WEB-001: Web application screen registry
export interface WebScreen {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly component: string;
  readonly accessible: boolean;
}

export const WEB_SCREENS: readonly WebScreen[] = Object.freeze([
  { id: 'doc', title: 'Documents', path: '/documents', component: 'DocumentWorkspace', accessible: true },
  { id: 'mm', title: 'Multimodal Studio', path: '/multimodal', component: 'MultimodalStudio', accessible: true },
  { id: 'notify', title: 'Notifications', path: '/notifications', component: 'NotificationCenter', accessible: true },
  { id: 'planning', title: 'Planning', path: '/planning', component: 'PlanningWorkspace', accessible: true },
  { id: 'reconcile', title: 'Reconciliation', path: '/reconcile', component: 'ReconciliationCenter', accessible: true },
  { id: 'research', title: 'Research', path: '/research', component: 'ResearchWorkspace', accessible: true },
  { id: 'writing', title: 'Writing', path: '/writing', component: 'WritingWorkspace', accessible: true },
]);

export function getScreen(id: string): WebScreen | undefined {
  return WEB_SCREENS.find(s => s.id === id);
}
