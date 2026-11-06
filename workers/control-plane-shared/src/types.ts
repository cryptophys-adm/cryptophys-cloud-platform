// Minimal structural types for the Cloudflare bindings used by the control plane.
// Kept local so the Workers type-check without a runtime-specific types package.

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
  [key: string]: unknown;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface VersionMetadata {
  id: string;
  tag?: string;
  timestamp?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

/**
 * The subset of the Cloudflare Workflows API the platform uses. The step functions run the
 * Workflow logic, which is written against these interfaces so it can be tested in Node.
 */
export type WorkflowDuration = string | number;
export interface WorkflowStepConfigLike {
  retries?: { limit: number; delay: WorkflowDuration; backoff?: "constant" | "linear" | "exponential" };
  timeout?: WorkflowDuration;
}
export interface WorkflowStepContextLike { attempt: number }
export interface WorkflowStepLike {
  do<T>(name: string, callback: (ctx: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfigLike, callback: (ctx: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: WorkflowDuration }): Promise<{ payload: T; timestamp: Date; type: string }>;
  /** Durable sleep (Cloudflare Workflows). Optional so older fakes still type-check. */
  sleep?(name: string, duration: WorkflowDuration): Promise<void>;
}
export interface WorkflowInstanceLike {
  id: string;
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
  terminate(): Promise<void>;
  status(): Promise<{ status: string; error?: unknown; output?: unknown }>;
}
export interface WorkflowBindingLike<P = unknown> {
  create(options?: { id?: string; params?: P }): Promise<WorkflowInstanceLike>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

/** Bindings every control-plane service Worker declares. */
export interface BaseEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  SERVICE_NAME: string;
  SERVICE_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  DB: D1Database;
  AI?: AiBinding;
  AI_MODEL?: string;
  AI_DAILY_REQUEST_LIMIT?: string;
  AI_ACCOUNT_DAILY_REQUEST_LIMIT?: string;
  /** Comma-separated Access identities (service-token Client IDs, emails) allowed to call /v1. */
  OPERATOR_IDENTITIES?: string;
  CF_VERSION_METADATA?: VersionMetadata;
}
