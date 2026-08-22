import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
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
  },
});
