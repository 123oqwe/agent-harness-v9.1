/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/event.schema.json. Do not modify by hand. */

export interface StreamEvent {
  event_id: string;
  sequence: number;
  run_id: string;
  agent_id?: string | null;
  step_id?: string | null;
  type: string;
  timestamp: string;
  payload: {
    [k: string]: unknown;
  };
  redaction_applied: boolean;
}
