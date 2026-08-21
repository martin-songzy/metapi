import { describe, expect, it } from 'vitest';

import { MODEL_PROBE_ENDPOINT_TYPES } from './modelProbePayloads.js';
import { parseSiteCreatePayload, parseSiteUpdatePayload } from './siteRoutePayloads.js';

const baseCreate = { name: 'probe-site', url: 'https://probe-site.example.com' };

describe('site payload probe request profile', () => {
  it('accepts every supported endpoint type on create and update', () => {
    expect(MODEL_PROBE_ENDPOINT_TYPES).toEqual(['auto', 'chat', 'messages', 'responses']);

    for (const probeEndpointType of MODEL_PROBE_ENDPOINT_TYPES) {
      const created = parseSiteCreatePayload({ ...baseCreate, probeEndpointType });
      expect(created.success, `create ${probeEndpointType}`).toBe(true);
      if (created.success) expect(created.data.probeEndpointType).toBe(probeEndpointType);

      const updated = parseSiteUpdatePayload({ probeEndpointType });
      expect(updated.success, `update ${probeEndpointType}`).toBe(true);
      if (updated.success) expect(updated.data.probeEndpointType).toBe(probeEndpointType);
    }
  });

  // 'response' is the plausible typo for the OpenAI Responses surface; an
  // unvalidated pass-through would persist it and silently disable probing.
  it('rejects the singular response spelling and arbitrary endpoint strings', () => {
    for (const probeEndpointType of ['response', 'completions', 'CHAT', 'auto ', '', null, 7]) {
      const created = parseSiteCreatePayload({ ...baseCreate, probeEndpointType });
      expect(created.success, `create ${String(probeEndpointType)}`).toBe(false);
      if (!created.success) expect(created.error).toContain('probeEndpointType');

      const updated = parseSiteUpdatePayload({ probeEndpointType });
      expect(updated.success, `update ${String(probeEndpointType)}`).toBe(false);
      if (!updated.success) expect(updated.error).toContain('probeEndpointType');
    }
  });

  it('trims the user agent and caps it at 512 characters', () => {
    const trimmed = parseSiteCreatePayload({ ...baseCreate, probeUserAgent: '  codex_cli_rs/0.20.0  ' });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data.probeUserAgent).toBe('codex_cli_rs/0.20.0');

    const atCap = parseSiteUpdatePayload({ probeUserAgent: `  ${'a'.repeat(512)}  ` });
    expect(atCap.success).toBe(true);
    if (atCap.success) expect(atCap.data.probeUserAgent).toBe('a'.repeat(512));

    for (const probeUserAgent of ['a'.repeat(513), 42, null]) {
      const created = parseSiteCreatePayload({ ...baseCreate, probeUserAgent });
      expect(created.success, `create ${String(probeUserAgent).slice(0, 12)}`).toBe(false);
      if (!created.success) expect(created.error).toContain('probeUserAgent');

      const updated = parseSiteUpdatePayload({ probeUserAgent });
      expect(updated.success, `update ${String(probeUserAgent).slice(0, 12)}`).toBe(false);
      if (!updated.success) expect(updated.error).toContain('probeUserAgent');
    }
  });

  it('accepts an empty user agent as an explicit "send no override"', () => {
    const created = parseSiteCreatePayload({ ...baseCreate, probeUserAgent: '   ' });
    expect(created.success).toBe(true);
    if (created.success) expect(created.data.probeUserAgent).toBe('');
  });

  // Existing callers never send these keys; they must stay absent rather than
  // materialize as values, so an update cannot overwrite a stored profile.
  it('leaves both fields undefined when they are omitted', () => {
    const created = parseSiteCreatePayload(baseCreate);
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.data.probeEndpointType).toBeUndefined();
      expect(created.data.probeUserAgent).toBeUndefined();
    }

    const updated = parseSiteUpdatePayload({ name: 'renamed' });
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.data.probeEndpointType).toBeUndefined();
      expect(updated.data.probeUserAgent).toBeUndefined();
    }
  });

  // The typed fields are added to schemas that still carry unknown extras
  // (apiEndpoints, postRefreshProbe*), so guard that behaviour too.
  it('keeps forwarding unrelated site fields', () => {
    const created = parseSiteCreatePayload({
      ...baseCreate,
      apiEndpoints: [{ url: 'https://api.example.com', enabled: true, sortOrder: 0 }],
      postRefreshProbeScope: 'all',
      probeEndpointType: 'messages',
    });
    expect(created.success).toBe(true);
    if (created.success) {
      const data = created.data as Record<string, unknown>;
      expect(data.apiEndpoints).toHaveLength(1);
      expect(data.postRefreshProbeScope).toBe('all');
      expect(data.probeEndpointType).toBe('messages');
    }
  });
});
