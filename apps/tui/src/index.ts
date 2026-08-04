export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-tui",
  path: "apps/tui",
} as const);

export interface TuiCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}

// AH-UI-TUI-001: Terminal UI with diff rendering
export interface TuiDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
}

export function renderDiff(oldLines: readonly string[], newLines: readonly string[]): TuiDiff {
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    added: newLines.filter(l => !oldSet.has(l)),
    removed: oldLines.filter(l => !newSet.has(l)),
    unchanged: newLines.filter(l => oldSet.has(l)),
  };
}
