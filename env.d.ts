/// <reference types="vite/client" />

// Ambient fallback so `*.vue` imports resolve even when the toolchain is not
// registering Vue's virtual modules (seen under oven/bun's builder image).
// `vue-tsc` supplies real component types and takes precedence when it works;
// this only prevents a hard TS2307 when it does not.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
