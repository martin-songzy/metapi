import { describe, expect, it } from 'vitest';

import vitestConfig from '../vitest.config.js';

/**
 * Guards the repo-root test-collection exclusions.
 *
 * Both entries protect the same property: a vitest run must only collect the
 * repository's own sources. `.worktrees/` holds sibling checkouts of this very
 * repo, and `tmp/` is the gitignored scratch area where agents and reviewers put
 * throwaway sandboxes — usually a COPY of `src/` alongside its own
 * `package.json`. Either one, once collected, runs the suite a second time
 * against a stale copy: observed once as ~467 extra test files, which nearly
 * doubled `npm test` and made both its pass count and its failures unreadable.
 *
 * Asserted against the imported config object rather than the file text, so a
 * refactor that keeps the string but drops it from `test.exclude` still fails.
 */
describe('repo-root vitest exclusions', () => {
  const exclude = vitestConfig.test?.exclude ?? [];

  it('excludes the scratch and sibling-worktree directories', () => {
    expect(exclude).toContain('tmp/**');
    expect(exclude).toContain('.worktrees/**');
  });

  it('keeps vitest\'s own defaults rather than replacing them', () => {
    // Spelling out `exclude` drops the defaults, which would start collecting
    // `node_modules` and `dist`.
    expect(exclude).toContain('**/node_modules/**');
    expect(exclude).toContain('**/dist/**');
  });
});
