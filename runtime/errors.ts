/** Runtime failures caused by invalid loop inputs, state, or model responses. */
export class LoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopError';
    Object.setPrototypeOf(this, LoopError.prototype);
  }
}
