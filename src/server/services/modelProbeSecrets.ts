/**
 * Value-based credential masking for the active model probe.
 *
 * This is the "we know the secret" half of probe redaction, and where it applies
 * it is the stronger half: `modelProbeApiService.redactUpstreamProbeText` can
 * only match secret *shapes*, so it cannot catch a bare `ghp_...`, a credential
 * embedded in a URL path segment (`/v1/<32-hex>/models`), or an opaque session
 * cookie like `session=MTcwMDAw...` — the shape a Veloera / AnyRouter relay
 * actually issues. Wherever the credential value is in scope, masking by value
 * closes that gap outright and must be preferred.
 *
 * Its limitation, stated plainly so nothing is built on a guarantee that is not
 * here: matching is BYTE-EXACT. Verified to handle regex metacharacters, empty
 * and short credentials, repeated and overlapping occurrences, and
 * null/undefined. It does NOT handle a credential a relay reformatted before
 * echoing it — case-variant, URL-encoded (`%2F`), or JSON-escaped (`\/`) forms
 * all pass through unmasked. That is an accepted limitation: relays echo the
 * bytes they received, and normalizing every encoding a body could apply would
 * be guesswork with its own false-positive cost. Boundary shape-matching is the
 * backstop for anything reformatted.
 *
 * Deliberately dependency-free (no db, no config, no platform adapters) so every
 * layer that holds a credential can import it: the discovery service builds its
 * error and note text with the credential in scope, and the run service masks the
 * probe `reason` the same way.
 *
 * Why relays echo the key at all: `platforms/base.ts` surfaces a failed management
 * call as `HTTP ${status}: ${body}` — the upstream response body verbatim. A relay
 * that quotes the rejected key in a 401/500 body therefore puts it straight into
 * the message text that reaches `liveFailure.message`, `notes[0]` and the
 * `no_models` error.
 */

export const MODEL_PROBE_CREDENTIAL_MASK = '[redacted-credential]';

/**
 * Minimum secret length worth masking. Below this a "credential" is almost
 * certainly a placeholder or a test fixture, and blanket-replacing a 3-character
 * string would shred unrelated words out of the diagnosis text — including the
 * upstream wording an operator needs to read.
 */
const MIN_MASKABLE_CREDENTIAL_LENGTH = 8;

/**
 * Replaces every occurrence of `credential` in `text` with the mask.
 *
 * Plain `split`/`join` rather than a RegExp: a credential can contain any
 * character, and building a pattern from it would either need escaping (one more
 * thing to get wrong) or would misbehave on a key containing regex metacharacters.
 */
export function maskCredentialInText(text: string, credential: string | null | undefined): string {
  const source = String(text ?? '');
  const secret = String(credential ?? '').trim();
  if (!secret || secret.length < MIN_MASKABLE_CREDENTIAL_LENGTH) return source;
  return source.split(secret).join(MODEL_PROBE_CREDENTIAL_MASK);
}

export const MODEL_PROBE_PROXY_CREDENTIAL_MASK = '[redacted-proxy-credential]';

/**
 * Strips `user:password@` from any URL-looking substring.
 *
 * Needed because the two masks above cover the SITE credential only, and a proxy
 * URL carries its own secret that no layer passes to them. Observed leaking for
 * real: a probe against a site with `socks5://user:pass@host:port` configured
 * failed with `Request cannot be constructed from a URL that includes
 * credentials: socks5://user:pass@host:port/v1/chat/completions`, and that message
 * became the persisted probe `reason` — so the proxy password was rendered on the
 * results page. Fixing the malformed URL removes that one path, but any socks or
 * CONNECT error can quote the proxy URL, so the redaction is the durable half.
 *
 * Shape-based by necessity: the proxy password is not in scope at the call sites
 * that build probe reasons, so byte-exact masking is not available here. Matches
 * `scheme://[userinfo@]host`, keeps the scheme and host so the diagnosis stays
 * readable, and replaces only the userinfo. A password containing `@` or `/` is
 * only partially matched — the greedy-free character class stops at the first `@`,
 * which can leave a fragment; accepted, because widening it risks eating a real
 * host out of the message.
 */
export function maskProxyCredentialsInText(text: string): string {
  const source = String(text ?? '');
  if (!source) return source;
  return source.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
    (_match, scheme: string) => `${scheme}${MODEL_PROBE_PROXY_CREDENTIAL_MASK}@`,
  );
}
