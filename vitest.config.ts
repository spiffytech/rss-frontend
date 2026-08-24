import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // Vitest covers Vue SFCs + the reading-pane directives/composables only.
      // Pure logic in src/shared is tested by `bun test src/shared`.
      include: ['src/client/**/*.spec.ts'],
      exclude: [...configDefaults.exclude, 'e2e/**', 'miniminiflux/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
)
