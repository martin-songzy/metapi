import { z } from 'zod';

import {
  MODEL_PROBE_ENDPOINT_TYPES,
  type ModelProbeEndpointType,
} from '../../shared/modelProbeEndpointTypes.js';

/**
 * Zod contracts for the active model probe API surface.
 *
 * These schemas only validate request shapes. Normalization defaults, clamping
 * and persistence live in `services/modelProbeConfigService.ts` so a payload
 * that parses here still passes through one canonical normalizer before it is
 * written, and so this module stays importable without a database.
 */

export const MAX_PROBE_USER_AGENT_LENGTH = 512;

const probeConcurrencySchema = z.number().int().min(1).max(8);
const probeTimeoutSchema = z.number().int().min(3000).max(60000);

const userAgentPresetSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  value: z.string().max(MAX_PROBE_USER_AGENT_LENGTH),
});

/**
 * Caps mirror the ones the config service applies to a hand-edited settings row,
 * so the API path and the direct-write path are bounded the same way.
 * `interestPatterns` uses the shared filter's 50/200 limits.
 */
const MAX_INTEREST_PATTERN_COUNT = 50;
const MAX_INTEREST_PATTERN_LENGTH = 200;
const MAX_PROMPT_COUNT = 50;
const MAX_PROMPT_LENGTH = 2_000;
const MAX_ERROR_KEYWORD_COUNT = 50;
const MAX_ERROR_KEYWORD_LENGTH = 200;
const MAX_USER_AGENT_PRESET_COUNT = 20;

const modelProbeConfigPayloadSchema = z.object({
  interestPatterns: z.array(z.string().max(MAX_INTEREST_PATTERN_LENGTH))
    .max(MAX_INTEREST_PATTERN_COUNT).optional(),
  prompts: z.array(z.string().max(MAX_PROMPT_LENGTH)).max(MAX_PROMPT_COUNT).optional(),
  userAgents: z.array(userAgentPresetSchema).max(MAX_USER_AGENT_PRESET_COUNT).optional(),
  defaultUserAgentId: z.string().trim().optional(),
  errorKeywords: z.array(z.string().max(MAX_ERROR_KEYWORD_LENGTH))
    .max(MAX_ERROR_KEYWORD_COUNT).optional(),
  concurrency: probeConcurrencySchema.optional(),
  timeoutMs: probeTimeoutSchema.optional(),
  syncToRouting: z.boolean().optional(),
}).strict();

export { MODEL_PROBE_ENDPOINT_TYPES, type ModelProbeEndpointType };

/**
 * The two per-site probe profile fields, exported as schemas rather than as raw
 * constants so every surface that accepts them (the dedicated site probe config
 * endpoint and the general site create/update payloads) validates identically.
 * Re-declaring `z.enum([...])` or the 512 cap per call site would let the two
 * surfaces drift apart silently.
 */
export const probeEndpointTypeSchema = z.enum(MODEL_PROBE_ENDPOINT_TYPES);
export const probeUserAgentSchema = z.string().trim().max(MAX_PROBE_USER_AGENT_LENGTH);

const modelProbeSiteConfigPayloadSchema = z.object({
  probeEndpointType: probeEndpointTypeSchema.optional(),
  probeUserAgent: probeUserAgentSchema.optional(),
}).strict();

const siteIdSchema = z.number().int().positive();

const modelProbePreviewPayloadSchema = z.object({
  siteId: siteIdSchema,
}).strict();

/**
 * An explicitly supplied model list is trimmed and deduped here, then collapsed
 * to `undefined` when nothing survives so the caller falls back to interest
 * matching instead of silently probing zero models.
 */
const explicitModelsSchema = z.array(z.string())
  .transform((models) => {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of models) {
      const model = entry.trim();
      if (!model) continue;
      const dedupeKey = model.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      normalized.push(model);
    }
    return normalized.length > 0 ? normalized : undefined;
  });

const modelProbeRunPayloadSchema = z.object({
  siteId: siteIdSchema,
  models: explicitModelsSchema.optional(),
  userAgentId: z.string().trim().min(1).optional(),
  concurrency: probeConcurrencySchema.optional(),
  timeoutMs: probeTimeoutSchema.optional(),
}).strict();

export const MODEL_PROBE_RESULT_STATUSES = ['supported', 'unsupported', 'inconclusive', 'skipped'] as const;

/**
 * A cleared UI filter serializes as an empty param (`?siteId=&status=`), and
 * `.optional()` alone does not accept `''` — it would 400 the whole listing. So a
 * blank string collapses to `undefined`, meaning "no filter", rather than erroring.
 */
const blankToUndefined = <S extends z.ZodTypeAny>(schema: S) => z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  schema.optional(),
);

const optionalQueryNumber = z.union([z.number(), z.string()])
  .transform((value, ctx) => {
    const numeric = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Expected a positive integer.' });
      return z.NEVER;
    }
    return numeric;
  });

/**
 * Unlike the request bodies above this schema is not strict: query strings pick
 * up unrelated params (cache busters, pagination cursors) and rejecting a probe
 * results listing over one of those would be a pointless failure.
 */
const modelProbeResultsQuerySchema = z.object({
  siteId: blankToUndefined(optionalQueryNumber),
  status: blankToUndefined(z.enum(MODEL_PROBE_RESULT_STATUSES)),
  limit: blankToUndefined(optionalQueryNumber.pipe(z.number().max(500))),
});

export type ModelProbeConfigPayload = z.output<typeof modelProbeConfigPayloadSchema>;
export type ModelProbePreviewPayload = z.output<typeof modelProbePreviewPayloadSchema>;
export type ModelProbeResultsQuery = z.output<typeof modelProbeResultsQuerySchema>;
export type ModelProbeRunPayload = z.output<typeof modelProbeRunPayloadSchema>;
export type ModelProbeSiteConfigPayload = z.output<typeof modelProbeSiteConfigPayloadSchema>;

type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

function normalizePayloadInput(input: unknown): unknown {
  if (input === undefined) return {};
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return null;
}

function formatPayloadError(error: z.ZodError, subject: string): string {
  const firstIssue = error.issues[0];
  if (firstIssue?.code === 'unrecognized_keys') {
    return `Unknown ${firstIssue.keys.join(', ')} in ${subject} payload.`;
  }

  const field = (firstIssue?.path ?? [])
    .filter((segment) => typeof segment === 'string')
    .join('.');
  if (!field) return `Invalid ${subject} payload. Expected an object.`;
  return `Invalid ${field} in ${subject} payload.`;
}

function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  subject: string,
): ParseResult<z.output<S>> {
  const result = schema.safeParse(normalizePayloadInput(input));
  if (!result.success) {
    return { success: false, error: formatPayloadError(result.error, subject) };
  }
  return { success: true, data: result.data };
}

export function parseModelProbeConfigPayload(input: unknown): ParseResult<ModelProbeConfigPayload> {
  return parseWith(modelProbeConfigPayloadSchema, input, 'probe config');
}

export function parseModelProbeSiteConfigPayload(input: unknown): ParseResult<ModelProbeSiteConfigPayload> {
  return parseWith(modelProbeSiteConfigPayloadSchema, input, 'site probe config');
}

export function parseModelProbePreviewPayload(input: unknown): ParseResult<ModelProbePreviewPayload> {
  return parseWith(modelProbePreviewPayloadSchema, input, 'probe preview');
}

export function parseModelProbeRunPayload(input: unknown): ParseResult<ModelProbeRunPayload> {
  return parseWith(modelProbeRunPayloadSchema, input, 'probe run');
}

export function parseModelProbeResultsQuery(input: unknown): ParseResult<ModelProbeResultsQuery> {
  return parseWith(modelProbeResultsQuerySchema, input, 'probe results query');
}
