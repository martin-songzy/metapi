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

// Caps mirror the config-service constants; duplicated as literals because that
// module imports the database and this one must stay importable without it. A
// test pins the pairs equal.
// Site fan-out is bounded by the operator's own tolerance for parallel paid
// requests, not by the transport: relays handle different-site traffic well, and
// a real account set (this deployment has ~20 sites) wants them all in flight at
// once. The ceiling exists only to catch a typo like 5000.
const probeSiteConcurrencySchema = z.number().int().min(1).max(50);
const probeModelConcurrencySchema = z.number().int().min(1).max(8);
const probeTimeoutSchema = z.number().int().min(3000).max(60000);
// Caps mirror `MODEL_PROBE_MIN/MAX_MAX_TOKENS` in the config service. Duplicated
// rather than imported because that module touches the database and this one must
// stay importable without it — same tradeoff as the concurrency/timeout literals
// above, which is why a test pins the two pairs equal.
const probeMaxTokensSchema = z.number().int().min(1).max(4_096);

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
  /**
   * Which stored patterns are switched OFF for the next sweep. Bounded by the same
   * caps as `interestPatterns` because it is a subset of it — the config service
   * additionally drops any entry that no longer names a stored pattern.
   */
  disabledInterestPatterns: z.array(z.string().max(MAX_INTEREST_PATTERN_LENGTH))
    .max(MAX_INTEREST_PATTERN_COUNT).optional(),
  prompts: z.array(z.string().max(MAX_PROMPT_LENGTH)).max(MAX_PROMPT_COUNT).optional(),
  userAgents: z.array(userAgentPresetSchema).max(MAX_USER_AGENT_PRESET_COUNT).optional(),
  defaultUserAgentId: z.string().trim().optional(),
  errorKeywords: z.array(z.string().max(MAX_ERROR_KEYWORD_LENGTH))
    .max(MAX_ERROR_KEYWORD_COUNT).optional(),
  siteConcurrency: probeSiteConcurrencySchema.optional(),
  modelConcurrency: probeModelConcurrencySchema.optional(),
  /**
   * Deprecated alias of `modelConcurrency`, accepted so a client or hand-edited
   * row from before the split keeps parsing; the config service maps it and the
   * normalized record only ever stores the new keys.
   */
  concurrency: probeModelConcurrencySchema.optional(),
  timeoutMs: probeTimeoutSchema.optional(),
  maxTokens: probeMaxTokensSchema.optional(),
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

export const MAX_MODEL_PROBE_SITE_IDS = 200;

/**
 * Preview and run are cross-site sweeps, so the scope is a site-id LIST, not a
 * single id: `previewActiveModelProbe` / `queueActiveModelProbe` accept
 * `{ siteIds }` and nothing else, and a payload field the service cannot honour
 * would be silently ignored.
 *
 * Omitting `siteIds` means "every active site". An explicitly supplied list must
 * name at least one site: collapsing `[]` to "all sites" would turn a UI where
 * the operator deselected everything into a full sweep against real quota. Ids
 * are deduped and sorted so the same scope always produces the same dedupe key.
 */
const siteIdsSchema = z.array(siteIdSchema)
  .min(1)
  .max(MAX_MODEL_PROBE_SITE_IDS)
  .transform((siteIds) => [...new Set(siteIds)].sort((left, right) => left - right));

const modelProbePreviewPayloadSchema = z.object({
  siteIds: siteIdsSchema.optional(),
}).strict();

const modelProbeRunPayloadSchema = z.object({
  siteIds: siteIdsSchema.optional(),
  /**
   * Echo of the target count the operator was shown. The run endpoint compares
   * it against a freshly computed preview, so a stale or invented number cannot
   * wave a large sweep through.
   */
  confirmedTargetCount: z.number().int().nonnegative().optional(),
}).strict();

/**
 * Filterable statuses on the results page.
 *
 * Includes the two per-key-only states, because the page lists per-key rows: a key
 * that was switched off or had no usable credential produces a row, and an operator
 * narrowing to 「密钥不可用」 is a real question the site-scoped vocabulary could not
 * express.
 */
export const MODEL_PROBE_RESULT_STATUSES = [
  'supported', 'unsupported', 'inconclusive', 'skipped', 'disabled', 'unavailable',
] as const;

/**
 * Every column the results table renders is sortable, so this list mirrors that
 * table's columns rather than the two or three that happen to be numeric.
 *
 * Kept as an explicit allow-list, not an open string: the service maps each entry
 * to a real column, and an unrecognized value must be a 400 rather than fall
 * through to a table silently ordered by something else.
 */
export const MODEL_PROBE_RESULT_SORT_FIELDS = [
  'site', 'model', 'status', 'key', 'latency', 'balance',
  'endpoint', 'checkedAt', 'prompt', 'userAgent', 'reason',
] as const;
export const MODEL_PROBE_RESULT_SORT_ORDERS = ['asc', 'desc'] as const;

/** Substring filter on the model name; the service lowercases and LIKEs it. */
const MAX_MODEL_FILTER_LENGTH = 200;

/**
 * A cleared UI filter serializes as an empty param (`?siteId=&status=`), and
 * `.optional()` alone does not accept `''` — it would 400 the whole listing. So a
 * blank string collapses to `undefined`, meaning "no filter", rather than erroring.
 */
const blankToUndefined = <S extends z.ZodTypeAny>(schema: S) => z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  schema.optional(),
);

function queryIntegerSchema(options: { min: number }) {
  return z.union([z.number(), z.string()])
    .transform((value, ctx) => {
      const numeric = typeof value === 'number' ? value : Number(value.trim());
      if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < options.min) {
        ctx.addIssue({
          code: 'custom',
          message: options.min > 0
            ? 'Expected a positive integer.'
            : 'Expected a non-negative integer.',
        });
        return z.NEVER;
      }
      return numeric;
    });
}

const optionalQueryNumber = queryIntegerSchema({ min: 1 });
/** Paging starts at row 0, so `offset` must accept it where ids and limits may not. */
const optionalQueryOffset = queryIntegerSchema({ min: 0 });

/**
 * Unlike the request bodies above this schema is not strict: query strings pick
 * up unrelated params (cache busters, pagination cursors) and rejecting a probe
 * results listing over one of those would be a pointless failure.
 *
 * `model` / `sortBy` / `order` / `offset` were added once the results service
 * grew sorting and paging. Validating the sort field here rather than letting the
 * service fall through to its default keeps a typo an explicit 400 instead of a
 * table silently sorted by something else.
 */
const modelProbeResultsQuerySchema = z.object({
  model: blankToUndefined(z.string().trim().max(MAX_MODEL_FILTER_LENGTH)),
  siteId: blankToUndefined(optionalQueryNumber),
  status: blankToUndefined(z.enum(MODEL_PROBE_RESULT_STATUSES)),
  sortBy: blankToUndefined(z.enum(MODEL_PROBE_RESULT_SORT_FIELDS)),
  order: blankToUndefined(z.enum(MODEL_PROBE_RESULT_SORT_ORDERS)),
  limit: blankToUndefined(optionalQueryNumber.pipe(z.number().max(500))),
  offset: blankToUndefined(optionalQueryOffset),
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
