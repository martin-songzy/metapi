/**
 * The endpoint a model probe sends its request to.
 *
 * Lives in `src/shared/` because both ends need it: the server validates
 * incoming site payloads against it (`contracts/modelProbePayloads.ts`) and the
 * web site editor renders it as a select (`pages/helpers/sitesEditor.ts`). Kept
 * as hand-written `.js` + `.d.ts` so it needs no build step, following
 * `siteInitializationPresets.js`.
 *
 * `'auto'` means "pick the endpoint from the site's platform capabilities",
 * which is the behaviour every site had before the field existed.
 */
export const MODEL_PROBE_ENDPOINT_TYPES = ['auto', 'chat', 'messages', 'responses'];

/**
 * Collapses anything unrecognized to `'auto'`. Rows written before the column
 * existed, hand-edited rows and downgraded backups can all hold values outside
 * the tuple, so every reader normalizes rather than trusting stored text.
 *
 * @param {unknown} value
 * @returns {'auto' | 'chat' | 'messages' | 'responses'}
 */
export function normalizeModelProbeEndpointType(value) {
  return MODEL_PROBE_ENDPOINT_TYPES.find((candidate) => candidate === value) ?? 'auto';
}
