import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    reporters: ['verbose'],
    include: ['src/**/*.test.ts'],
  },
});
