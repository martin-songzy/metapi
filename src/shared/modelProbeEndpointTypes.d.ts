export declare const MODEL_PROBE_ENDPOINT_TYPES: readonly ['auto', 'chat', 'messages', 'responses'];
export type ModelProbeEndpointType = (typeof MODEL_PROBE_ENDPOINT_TYPES)[number];
export declare function normalizeModelProbeEndpointType(value: unknown): ModelProbeEndpointType;
