import adapter from '@sveltejs/adapter-bun'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter(),
      preprocess: vitePreprocess(),
      compilerOptions: {
        runes: true,
      },
    }),
    {
      // bun: builtins (bun:sqlite …) must stay external in the server build —
      // they resolve at runtime under Bun (adapter-bun), not Node's ESM loader.
      name: 'externalize-bun-builtins',
      enforce: 'pre' as const,
      resolveId(id: string) {
        return id.startsWith('bun:') ? { id, external: true } : null
      },
    },
  ],
})
