/**
 * Fetch the model list scoped to ONE token, via the OpenAI-compatible
 * `GET /v1/models` endpoint.
 *
 * Why this exists: platform adapters read the site's management API, whose model
 * list is scoped to the USER (or to every group the user can reach). The probe then
 * sends its real requests with a specific TOKEN, and tokens belong to one group —
 * so a model the management API happily lists can be unreachable for that key
 * ("无可用渠道"), and the sweep reports failures for models that work fine through
 * a different key on the same site. `/v1/models`, authenticated AS the probe key,
 * answers exactly what that key can reach, which makes the target list and the
 * probing credential agree.
 *
 * Contract, and the reason discovery needs no try/catch around it: this function
 * NEVER throws. Every failure mode — transport, timeout, non-2xx, unparseable body,
 * unusable payload — becomes `null`, which the caller reads as "this endpoint told
 * us nothing; fall back to the adapter path". A 200 with an empty list is returned
 * as `[]`, not null: it means the endpoint worked and this key reaches nothing,
 * which is a different fact, and the caller's existing empty-live handling applies.
 *
 * Deliberately dependency-free at RUNTIME (no db, no config, no siteProxy import)
 * so it stays unit-testable without the discovery service's mock harness. The proxy
 * dispatcher is installed by the CALLER through `buildRequestInit`; this module must
 * not know how proxying works.
 */

/** Extracts model names from a `/v1/models` payload; null when unusable. */
export function parseTokenModelsPayload(payload: unknown): string[] | null {
  const entries: unknown[] | null = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null);
  if (!entries) return null;

  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      names.push(entry);
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { id?: unknown; model?: unknown; name?: unknown };
    const identifier = [record.id, record.model, record.name]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    if (identifier) names.push(identifier);
  }
  return names;
}

/**
 * Fetches `/v1/models` as the given credential.
 *
 * Returns the raw identifier strings (dedup/normalisation is the caller's job, so
 * this stays byte-faithful to the upstream), or null on ANY failure. An empty but
 * well-formed list comes back as `[]`.
 */

/** The request options this module builds and only ever passes opaquely. */
type TokenModelsRequestInit = {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Callers may attach anything else (dispatcher hints, extra headers). */
  [key: string]: unknown;
};

/**
 * Structural minimums instead of `typeof fetch` / lib `RequestInit`: this repo's
 * global fetch declaration overloads into demanding
 * `RequestInit & undici.RequestInit`, and those two same-named types disagree about
 * whether `body` accepts null, so nothing satisfies the intersection. Node's real
 * fetch and undici's `withSiteRecordProxyRequestInit` both satisfy these shapes.
 */
export type FetchLike = (
  url: string,
  init?: TokenModelsRequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export async function fetchTokenAccessibleModels(input: {
  baseUrl: string;
  credential: string;
  timeoutMs: number;
  /** Installs proxy/auth extras onto the request init before fetch. Optional. */
  buildRequestInit?: (init: TokenModelsRequestInit) => unknown | Promise<unknown>;
  fetchImpl?: FetchLike;
}): Promise<string[] | null> {
  const credential = String(input.credential ?? '').trim();
  if (!credential) return null;

  // Sites configure their API base with or without a trailing `/v1`; appending
  // naively would request `/v1/v1/models` on the latter. Mirrors the
  // version-suffix rule `buildUpstreamUrl` applies elsewhere.
  const trimmed = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const url = /\/v1$/i.test(trimmed)
    ? `${trimmed}/models`
    : `${trimmed}/v1/models`;

  const doFetch: FetchLike = input.fetchImpl
    ?? (globalThis.fetch as unknown as FetchLike);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error('token model catalog timeout')), Math.max(1, input.timeoutMs));
    timer.unref?.();

    const baseInit: TokenModelsRequestInit = {
      method: 'GET',
      headers: { authorization: `Bearer ${credential}` },
      signal: controller.signal,
    };
    const requestInit = input.buildRequestInit
      ? await input.buildRequestInit(baseInit)
      : baseInit;

    const response = await doFetch(url, requestInit as TokenModelsRequestInit);
    if (!response.ok) return null;

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
    return parseTokenModelsPayload(payload);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
