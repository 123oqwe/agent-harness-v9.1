export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-desktop",
  path: "apps/desktop",
} as const);

export interface DesktopCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}

// AH-UX-DESKTOP-001: Desktop/local shell application
export interface DesktopConfig {
  readonly shell: 'electron' | 'tauri' | 'native';
  readonly auto_update: boolean;
  readonly offline_cache: boolean;
}

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = Object.freeze({
  shell: 'native',
  auto_update: false,
  offline_cache: true,
});
