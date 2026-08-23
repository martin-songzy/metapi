import { describe, expect, it } from 'vitest';

import vitestConfig from '../vitest.config.js';

/**
 * Guards the repo-root test-collection exclusions.
 *
 * Both entries protect the same property: a vitest run must only collect the
 * repository's own sources. `.claude/worktrees/` holds sibling checkouts of this
 * very repo, and `tmp/` is the gitignored scratch area where agents and reviewers
 * put throwaway sandboxes — usually a COPY of `src/` alongside its own
 * `package.json`. Either one, once collected, runs the suite a second time
 * against a stale copy: observed once as ~467 extra test files, which nearly
 * doubled `npm test` and made both its pass count and its failures unreadable.
 *
 * Asserted by MATCHING REAL PATHS, not by `toContain`-ing the pattern strings.
 * That distinction is the whole point of this file: an earlier version asserted
 * `toContain('.worktrees/**')` and passed for months while the directory
 * worktrees are actually created in — `.claude/worktrees/` — went on being
 * collected, because a leading-segment glob is not a substring match. A test that
 * only echoes the config back cannot tell a correct pattern from a near-miss.
 */
describe('repo-root vitest exclusions', () => {
  const exclude = vitestConfig.test?.exclude ?? [];

  /**
   * Handles the `prefix/**` form only, which is the form every pattern below
   * uses. Deliberately not a full glob engine — vitest owns the real matching,
   * and reimplementing it here would just move the bug.
   */
  function isExcluded(path: string): boolean {
    return exclude.some((pattern) => (
      pattern.endsWith('/**') && path.startsWith(`${pattern.slice(0, -'/**'.length)}/`)
    ));
  }

  it.each([
    // The exact path a run from the shared checkout was seen to collect.
    '.claude/worktrees/active-model-probe/src/server/db/schemaUpgrade.live.test.ts',
    '.worktrees/legacy-location/src/server/db/schemaUpgrade.live.test.ts',
    'tmp/mp-sandbox/src/server/services/modelProbeRunService.test.ts',
  ])('excludes %s', (path) => {
    expect(isExcluded(path)).toBe(true);
  });

  it('still collects the repository\'s own tests', () => {
    // Positive control: without it, an over-broad pattern (or an `isExcluded`
    // that always returns true) would satisfy every assertion above.
    expect(isExcluded('src/server/db/schemaUpgrade.live.test.ts')).toBe(false);
    expect(isExcluded('src/web/pages/modelProbe.run.test.tsx')).toBe(false);
  });

  it('keeps vitest\'s own defaults rather than replacing them', () => {
    // Spelling out `exclude` drops the defaults, which would start collecting
    // `node_modules` and `dist`.
    expect(exclude).toContain('**/node_modules/**');
    expect(exclude).toContain('**/dist/**');
  });
});
