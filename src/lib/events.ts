import type { FailureCode, Category, University, Resolution, ImageCardData, Profile } from "@/server/contracts";
export type Stage = "resolving" | "discovering" | "preparing" | "assessing" | "assembling";
export type TerminalState = Profile["state"] | "needs_selection" | "not_found";
export interface EventPayloads {
  stage: { stage: Stage };
  identity: { university: University };
  clarification: { choices: Extract<Resolution, { kind: "needs_selection" }>["choices"] };
  image: { card: ImageCardData };
  warning: { code: FailureCode; message: string; category?: Category };
  final: { state: TerminalState; profile: Profile | null; elapsedMs: number };
  fatal: { code: FailureCode; message: string; retryAfterSeconds?: number };
}
export type ProfileEvent = { [K in keyof EventPayloads]: { v: 1; requestId: string; seq: number; type: K; data: EventPayloads[K] } }[keyof EventPayloads];
export type EventBody = { [K in keyof EventPayloads]: { type: K; data: EventPayloads[K] } }[keyof EventPayloads];
export type Emit = (event: EventBody) => void;
