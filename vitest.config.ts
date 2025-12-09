import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['verbose'], // Print each test name as it runs

    // Only run tests from src/ - not from dist/
    // Rationale:
    // - The build step (tsc) already verifies TypeScript compiles correctly
    // - Running the same tests from both src and dist is redundant
    // - It doubles test time and creates port collision issues
    // - Source tests are sufficient to verify functionality
    exclude: ['**/node_modules/**', '**/dist/**'],

    // Run tests sequentially within each file to avoid port collisions
    // Tests that start gRPC servers need previous servers fully shut down
    sequence: {
      concurrent: false,
    },
  },
});
