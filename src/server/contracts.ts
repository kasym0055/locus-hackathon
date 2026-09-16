export interface RunContext {
  readonly requestId: string;
  readonly sessionId: string;
  readonly ipHash: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly deadlineAt: number;
}

export interface RunContextInput {
  requestId: string;
  sessionId: string;
  ipHash: string;
  signal: AbortSignal;
  now: number;
}
