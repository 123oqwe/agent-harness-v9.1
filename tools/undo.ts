/** #10: undo tool — restores workspace to a previously created checkpoint. */
export interface UndoInput { checkpoint: string }
export interface UndoOutput { restored: boolean; checkpoint: string }

export async function undo(
  _restoreFn: (id: string) => void,
  input: UndoInput,
): Promise<UndoOutput> {
  if (!input.checkpoint || input.checkpoint.length === 0) {
    throw new Error('undo: checkpoint id is required');
  }
  _restoreFn(input.checkpoint);
  return { restored: true, checkpoint: input.checkpoint };
}
