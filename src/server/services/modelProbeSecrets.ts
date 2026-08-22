/**
 * Value-based credential masking for the active model probe.
 *
 * This is the "we know the secret" half of probe redaction, and it is the
 * stronger half: `modelProbeApiService.redactUpstreamProbeText` can only match
 * secret *shapes*, so it cannot catch a bare `ghp_...`, a credential embedded in a
 * URL path segment (`/v1/<32-hex>/models`), or an opaque session cookie like
 * `session=MTcwMDAw...` — the shape a Veloera / AnyRouter relay actually issues.
 * Wherever the credential value is in scope, masking by value closes that gap
 * outright and must be preferred.
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
