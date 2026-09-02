import { z } from 'zod';

import {
  MAX_PROBE_USER_AGENT_LENGTH,
  MODEL_PROBE_ENDPOINT_TYPES,
  probeEndpointTypeSchema,
  probeUserAgentSchema,
} from './modelProbePayloads.js';

const requiredTrimmedString = z.string().trim().min(1);
const unknownField = z.unknown().optional();

/**
 * The per-site probe request profile is declared as *typed* fields, unlike the
 * `unknownField` entries around it. Those legacy fields are re-validated by
 * hand-written normalizers in `routes/api/sites.ts`; these two are validated
 * here so a bad value is a 400 instead of something that reaches the column.
 * `.passthrough()` below would otherwise forward `probeEndpointType: 'response'`
 * verbatim and permanently mis-target that site's probes.
 *
 * Both stay `.optional()`: existing clients (and every other part of the site
 * editor) never send them, and an absent key must mean "leave the stored profile
 * alone" rather than "reset it".
 */
const probeProfileFields = {
  probeEndpointType: probeEndpointTypeSchema.optional(),
  probeUserAgent: probeUserAgentSchema.optional(),
};

const siteCreatePayloadSchema = z.object({
  name: requiredTrimmedString,
  url: requiredTrimmedString,
  platform: z.string().trim().optional(),
  initializationPresetId: z.union([z.string(), z.null()]).optional(),
  proxyRef: unknownField,
  customHeaders: unknownField,
  externalCheckinUrl: unknownField,
  status: unknownField,
  isPinned: unknownField,
  sortOrder: unknownField,
  globalWeight: unknownField,
  ...probeProfileFields,
}).passthrough();

const siteUpdatePayloadSchema = z.object({
  name: requiredTrimmedString.optional(),
  url: requiredTrimmedString.optional(),
  platform: requiredTrimmedString.optional(),
  proxyRef: unknownField,
  customHeaders: unknownField,
  externalCheckinUrl: unknownField,
  status: unknownField,
  isPinned: unknownField,
  sortOrder: unknownField,
  globalWeight: unknownField,
  ...probeProfileFields,
}).passthrough();

const siteBatchPayloadSchema = z.object({
  ids: z.array(z.number().int().positive()).optional(),
  action: z.string().optional(),
  proxyRef: unknownField,
}).passthrough();

const siteDisabledModelsPayloadSchema = z.object({
  models: z.array(z.string()).optional(),
}).passthrough();

const siteDetectPayloadSchema = z.object({
  url: requiredTrimmedString,
}).passthrough();

export type SiteBatchPayload = z.output<typeof siteBatchPayloadSchema>;
export type SiteCreatePayload = z.output<typeof siteCreatePayloadSchema>;
export type SiteDetectPayload = z.output<typeof siteDetectPayloadSchema>;
export type SiteDisabledModelsPayload = z.output<typeof siteDisabledModelsPayloadSchema>;
export type SiteUpdatePayload = z.output<typeof siteUpdatePayloadSchema>;

function normalizeSitePayloadInput(input: unknown): unknown {
  if (input === undefined) return {};
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return null;
}

function formatSitePayloadError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const firstPath = firstIssue?.path[0];
  if (firstPath === 'name') {
    return 'Invalid name. Expected non-empty string.';
  }
  if (firstPath === 'url') {
    return 'Invalid url. Expected non-empty string.';
  }
  if (firstPath === 'platform') {
    return 'Invalid platform. Expected string.';
  }
  if (firstPath === 'ids') {
    return 'Invalid ids. Expected number[].';
  }
  if (firstPath === 'action') {
    return 'Invalid action. Expected string.';
  }
  if (firstPath === 'models') {
    return 'Invalid models. Expected string[].';
  }
  if (firstPath === 'probeEndpointType') {
    return `Invalid probeEndpointType. Expected one of ${MODEL_PROBE_ENDPOINT_TYPES.join(', ')}.`;
  }
  if (firstPath === 'probeUserAgent') {
    return `Invalid probeUserAgent. Expected a string of at most ${MAX_PROBE_USER_AGENT_LENGTH} characters.`;
  }
  return 'Invalid site payload.';
}

export function parseSiteCreatePayload(input: unknown):
{ success: true; data: SiteCreatePayload } | { success: false; error: string } {
  const result = siteCreatePayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteUpdatePayload(input: unknown):
{ success: true; data: SiteUpdatePayload } | { success: false; error: string } {
  const result = siteUpdatePayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteBatchPayload(input: unknown):
{ success: true; data: SiteBatchPayload } | { success: false; error: string } {
  const result = siteBatchPayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteDisabledModelsPayload(input: unknown):
{ success: true; data: SiteDisabledModelsPayload } | { success: false; error: string } {
  const result = siteDisabledModelsPayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteDetectPayload(input: unknown):
{ success: true; data: SiteDetectPayload } | { success: false; error: string } {
  const result = siteDetectPayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}
