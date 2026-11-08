import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // Several suites (llm-proxy-server, egress-network, gc) spawn real child processes / docker probes;
    // their boot contends under parallel load, so give them headroom above vitest's 5s default.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclude non-logic files: tests, fixtures, pure type declarations, barrel re-exports, CLI entry,
      // and the .mjs sidecar servers (not run under vitest).
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.fixture.ts',
        'src/**/types.ts',
        'src/index.ts',
        'src/*-labels.ts',
      ],
      reporter: ['text-summary'],
      // Floor is a ratchet, ~2pts below the measured baseline: catches a real regression without
      // flaking on v8's run-to-run variance. Raised by `pnpm coverage:ratchet --write` (never lowered
      // automatically) — see CONTRIBUTING.md and scripts/coverage-ratchet.ts.
      thresholds: { statements: 86, branches: 79, functions: 84, lines: 88 },
    },
  },
});
