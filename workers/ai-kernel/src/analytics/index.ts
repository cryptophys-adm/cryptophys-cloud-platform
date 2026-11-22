// The AI Kernel's Analytics Engine telemetry (ADR-0015 decision 6, phase 3). Writes only; nothing here reads the data back.
export { MAX_BLOBS, MAX_DOUBLES, MAX_INDEX_BYTES, MAX_BLOB_TOTAL_BYTES, MAX_POINTS_PER_INVOCATION, assertSchema, type DatasetSchema } from "./schema.ts";
export { writePoint, writePoints, truncateUtf8, type AnalyticsEngineBinding, type WriteOptions } from "./writer.ts";
export { startInvocation, tryConsumePoint, budgetSnapshot } from "./budget.ts";
export {
  AGENT_RUNTIME, AGENT_RUNTIME_SCHEMA_VERSION, ALL_DATASETS, CONTROL_PLANE, CONTROL_PLANE_SCHEMA_VERSION,
  recordAgentSyscall, recordControlPlaneJob, type AgentSyscall, type ControlPlaneJob, type JobOutcome, type SyscallOutcome,
} from "./datasets.ts";
export { KERNEL_SERVICE, recordCronJob, recordSyscall, sampleRateOf, trackJob, type TelemetryEnv } from "./telemetry.ts";
