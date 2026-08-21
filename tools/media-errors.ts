/**
 * Shared structured failures for the Phase 3 media/desktop tools
 * (AH-TOOL-VIDEO-GEN-001, AH-TOOL-MUSIC-GEN-001, AH-TOOL-VIDEO-EDIT-001,
 * AH-TOOL-BROWSER-001, AH-TOOL-COMPUTER-001). The ToolDispatcher converts a
 * thrown error into a structured receipt (`success: false`, `error`), so the
 * error message carries the machine-readable code the spec requires.
 */

/** A required capability/dependency is not available (e.g. no ffmpeg, no API key). */
export class ToolUnavailableError extends Error {
  readonly name = 'ToolUnavailableError';
  constructor(detail: string) {
    super(`tool_unavailable: ${detail}`);
    Object.setPrototypeOf(this, ToolUnavailableError.prototype);
  }
}

/** A generic tool failure (provider error, egress denied, invalid path). */
export class MediaToolError extends Error {
  readonly name = 'MediaToolError';
  constructor(detail: string) {
    super(`media_tool_error: ${detail}`);
    Object.setPrototypeOf(this, MediaToolError.prototype);
  }
}

/** Reject with a ToolUnavailableError if `promise` does not settle within `ms`. */
export function withTimeout<T>(ms: number, promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ToolUnavailableError(message)), ms);
  });
  // Clear the timer only when the race settles — never synchronously.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
