import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Dev: Vite serves the SPA on 5173 and proxies API calls to the
    // Bun.serve Hono API on 3100 (see src/server/index.ts).
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
})
