import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Two locations, because this repo has used both. `.claude/worktrees/` is
      // where worktrees are actually created today, and `.worktrees/` alone does
      // NOT match it — a leading-segment glob is not a substring match. That gap
      // was observed in the wild: a run from the shared checkout collected both
      // `src/server/db/schemaUpgrade.live.test.ts` and
      // `.claude/worktrees/active-model-probe/src/server/db/schemaUpgrade.live.test.ts`,
      // so every suite ran twice against two different commits of the same repo.
      '.worktrees/**',
      '.claude/worktrees/**',
      // `tmp/` is the gitignored scratch area agents and reviewers use for
      // throwaway sandboxes, and a sandbox is usually a COPY of `src/` plus its
      // own `package.json`. Without this, `npm test` collects those copies and
      // silently runs the suite twice — once observed as ~467 extra test files,
      // which nearly doubled the run and made its results meaningless.
      'tmp/**',
    ],
    // Many of our web tests rely on React's test utilities (act, etc.).
    // If NODE_ENV is accidentally set to "production" in the environment,
    // React switches to the production build where act() is not supported.
    // Force a safe default so local/CI runs are stable.
    env: {
      NODE_ENV: process.env.NODE_ENV && process.env.NODE_ENV !== 'production' ? process.env.NODE_ENV : 'test',
    },
    /**
     * Raised from the 10s default because most of our suite-level `beforeAll` hooks
     * migrate a fresh SQLite file, and on Windows that regularly exceeds 10s when
     * several suites start at once — a whole file then reports as failed with
     * "Hook timed out", followed by a misleading `app.close()` TypeError, while every
     * test in it is skipped. A hook that genuinely hangs still fails, just later.
     */
    hookTimeout: 60_000,
  },
});
