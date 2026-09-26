import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const packages = [
  'core',
  'llm',
  'tools',
  'context',
  'knowledge',
  'memory',
  'orchestration',
  'security',
  'observability',
  'evaluation',
  'cli',
];

export default defineConfig({
  test: {
    projects: packages.map((name) => ({
      test: {
        name,
        root: resolve(__dirname, `packages/${name}`),
        config: resolve(__dirname, `packages/${name}/vitest.config.ts`),
      },
    })),
  },
});
