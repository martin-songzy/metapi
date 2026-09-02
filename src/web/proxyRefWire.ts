/**
 * Wire sentinel for a CONNECTION choosing "follow the site".
 *
 * Mirrors `PROXY_REF_INHERIT` in `src/server/services/accountExtraConfig.ts`; the two
 * must stay in step. A connection has four wire states (untouched / follow the site /
 * explicitly direct / one pool entry) and one optional-nullable field carries three,
 * so the fourth needs a name. Pool ids are always `px_<hex>`, so it cannot collide.
 *
 * Deliberately its OWN module rather than an export of `api.ts`: tests replace that
 * module wholesale with `vi.mock('../api.js', () => ({ api: apiMock }))`, and a
 * constant living there would vanish in every one of them.
 */
export const PROXY_REF_INHERIT = 'inherit';
