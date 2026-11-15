// The Infrastructure page reads drift state and probe times the way control-plane-shared/src/service-detail.ts
// defines them (unit-tested there).
export { NOT_MEASURED, UNTAGGED_LABEL, UNTAGGED_REASON, driftReasons, driftState, lastProbeAt, minutesSince, onlyUntagged, probeAges } from "../../../../control-plane-shared/src/service-detail";
