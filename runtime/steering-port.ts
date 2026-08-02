export type RuntimeSteeringQueue = "steer" | "follow_up" | "next_turn";
export type RuntimeSteeringPriority =
  | "kill"
  | "security"
  | "human_cancel"
  | "human_correction"
  | "admin"
  | "user"
  | "supervisor"
  | "agent";

export interface RuntimeSteeringCommand {
  readonly command_id: string;
  readonly queue: RuntimeSteeringQueue;
  readonly priority: RuntimeSteeringPriority;
  readonly content: unknown;
}

export interface RuntimeSteeringScope {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
}

export type RuntimeSteeringEvent =
  | {
      readonly schema_version: "steering-event/v1";
      readonly kind: "enqueued";
      readonly scope: RuntimeSteeringScope;
      readonly command: RuntimeSteeringCommand & {
        readonly scope: RuntimeSteeringScope;
        readonly ordinal: number;
        readonly fingerprint: string;
      };
    }
  | {
      readonly schema_version: "steering-event/v1";
      readonly kind: "consumed";
      readonly scope: RuntimeSteeringScope;
      readonly command_id: string;
    };

export interface RuntimeSteeringPort {
  drain(queue: RuntimeSteeringQueue): readonly RuntimeSteeringCommand[];
  subscribe(listener: (command: RuntimeSteeringCommand) => void): () => void;
}

export interface RuntimeSteeringFactoryPort {
  bind(input: {
    readonly session: DurableSession;
    readonly scope: RuntimeSteeringScope;
  }): RuntimeSteeringPort;
}
import type { DurableSession } from "../session/durable-session.js";
