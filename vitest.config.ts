import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: {
    postcss: { plugins: [] },
  },
  test: {
    globals: true,
    environment: 'node',
    env: {
      STORAGE_CONFIG_PATH: 'memory',
    },
    include: ['src/**/*.test.ts', 'test_scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
