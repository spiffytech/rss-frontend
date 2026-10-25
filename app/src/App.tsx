import type { JSX } from '@solidjs/web'
import { onSettled } from 'solid-js'
import { Router } from './router.tsx'

/**
 * The app shell. Chrome (toolbar, sidebar, reading pane) belongs to the reader
 * page itself — the login screen has none — so this only mounts the router.
 */
export default function App() {
  onSettled(() => {
    // <lite-youtube> elements are created by the display pipeline
    // (lib/display/render.ts), but the element is only *defined* by importing
    // the package. That module registers a custom element and so touches
    // `document` at import time: browser-only, hence here rather than in
    // render.ts (which the server also loads).
    void import('lite-youtube-embed')
  })

  return (
    <Router>
      {(props: { children?: JSX.Element }) => <>{props.children}</>}
    </Router>
  )
}
