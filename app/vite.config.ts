import { defineConfig } from 'vite'
import solid from '@solidjs/vite-plugin'

export default defineConfig({
  plugins: [
    solid({
      ssr: true,
      serverFunctions: true,
      start: {
        middleware: './src/middleware.ts',
      },
    }),
  ],
  server: {
    port: 5173,
  },
  build: {
    // Bun builtins are not node: builtins, so Vite will not externalize them on
    // its own. Without this the SSR build tries to resolve `bun:sqlite`.
    rolldownOptions: {
      external: [/^bun(:|$)/],
    },
  },
  ssr: {
    external: ['bun', 'bun:sqlite'],
  },
})
