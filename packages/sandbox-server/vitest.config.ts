import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000, // 60 seconds per test
    hookTimeout: 30000, // 30 seconds for beforeAll/afterAll
  },
});
