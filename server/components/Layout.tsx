import type { FC, PropsWithChildren } from 'hono/jsx'
import { cssUrl } from '../lib/assets'

interface LayoutProps {
  title?: string
}

const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title = 'Miniflux Reader', children }) => {
  const cssAsset = cssUrl()
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="icon" href="/favicon.svg" />
        <link rel="stylesheet" href={cssAsset} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap"
        />
        <script
          type="module"
          src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js"
        ></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `// Consolidated datastar plugin bootstrap. One import; registers:
//   - on-intersect-line (auto-read line; scroll-container-relative)
//   - on-intersect (infinite-scroll sentinel; shadow of the built-in so we
//     can root the observer at the scroll container and add a preload margin)
//   - track-top ($currentId ground truth — which entry is at the top)
// Navigation, auto-read, icon fallback and all prefs are signal-driven in the
// server HTML; no window.* helpers remain.
document.addEventListener('datastar-ready', () => {
  import('https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js').then(({ attribute, mergePatch }) => {
    // Shared per-scroll-root state for track-top (one observer + a registry of
    // each observed entry's top/bottom), so a single deterministic winner can
    // be chosen per batch instead of letting the last observer to fire win.
    const trackTopState = new WeakMap();
    attribute({
      name: 'on-intersect-line',
      requirement: { key: 'denied', value: 'must' },
      apply({ el, rx }) {
        const scrollRoot = el.closest('[data-testid="entry-list"]')?.parentElement
          ?? document.body;
        let initialized = false;
        let intersecting = false;
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!initialized) {
              // IntersectionObserver reports initial state on observe(); record
              // it so the top-of-list entry (already in/above the band) is caught
              // by the first-scroll hook below, but don't fire yet — a freshly
              // patched row sitting on the line shouldn't auto-read immediately.
              initialized = true;
              intersecting = entry.isIntersecting;
              continue;
            }
            if (entry.isIntersecting) {
              intersecting = true;
              rx();
            } else {
              intersecting = false;
            }
          }
        }, {
          root: scrollRoot,
          rootMargin: '-15% 0px -85% 0px',
          threshold: 0,
        });
        observer.observe(el);
        // The first entry's top sits above the line at load, so it never
        // produces a positive "entering the band" crossing in the scroll-down
        // direction. Catch it once on the first scroll while it still
        // intersects the band. Guard the signal so the read isn't dropped if
        // this listener runs before datastar's own data-on:scroll handler.
        const onScroll = () => {
          if (initialized && intersecting) {
            mergePatch({ userHasScrolled: true });
            rx();
          }
          scrollRoot.removeEventListener('scroll', onScroll);
        };
        scrollRoot.addEventListener('scroll', onScroll, { passive: true });
        return () => {
          observer.disconnect();
          scrollRoot.removeEventListener('scroll', onScroll);
        };
      },
    });
    // Sentinel scroll observer: fires on EVERY intersection including the
    // initial mount report, so an under-filled viewport immediately fetches
    // more pages. Uses a generous rootMargin so it fires before the sentinel
    // reaches the exact bottom.
    attribute({
      name: 'on-intersect',
      requirement: { key: 'denied', value: 'must' },
      apply({ el, rx }) {
        const scrollRoot = el.closest('[data-testid="entry-list"]')?.parentElement
          ?? document.body;
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) rx();
          }
        }, {
          root: scrollRoot,
          rootMargin: '0px 0px 400px 0px',
          threshold: 0,
        });
        observer.observe(el);
        return () => observer.disconnect();
      },
    });
    // $currentId ground truth: which entry's top sits at (or just above) the
    // top of the scroll container. A thin band at the top of the container;
    // the entry intersecting it owns $currentId. Only writes the signal on a
    // real change; never reads the DOM on demand.
    //
    // One shared IntersectionObserver per scroll root observes every
    // [data-track-top] entry. On each batch it records each entry's top/bottom
    // (relative to the container top, so a partially-scrolled-out entry has a
    // negative top) and picks a single deterministic winner — the topmost
    // still-visible entry — instead of letting whichever observer fires last
    // win. This handles tall expanded entries (no threshold dead-zone) and
    // avoids flickering between two entries during a handoff.
    attribute({
      name: 'track-top',
      requirement: { key: 'denied', value: 'must' },
      apply({ el }) {
        const scrollRoot = el.closest('[data-testid="entry-list"]')?.parentElement
          ?? document.body;
        if (!trackTopState.has(scrollRoot)) {
          const registry = new Map();
          const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.rootBounds) continue;
              const top = entry.boundingClientRect.top - entry.rootBounds.top;
              const bottom = entry.boundingClientRect.bottom - entry.rootBounds.top;
              registry.set(entry.target.getAttribute('data-track-top'), { top, bottom });
            }
            let best = null;
            let bestTop = Infinity;
            for (const [entryId, r] of registry) {
              if (r.bottom <= 0) continue;
              if (r.top < bestTop) { bestTop = r.top; best = entryId; }
            }
            if (best != null) mergePatch({ currentId: Number(best) });
          }, {
            root: scrollRoot,
            // Only the sliver at the very top of the container triggers.
            rootMargin: '0px 0px -95% 0px',
            threshold: 0,
          });
          trackTopState.set(scrollRoot, { observer, registry });
        }
        const s = trackTopState.get(scrollRoot);
        s.observer.observe(el);
        return () => {
          s.registry.delete(el.getAttribute('data-track-top'));
          s.observer.unobserve(el);
        };
      },
    });
  });
});
// Sidebar drag-to-resize (desktop only). Pure pointer events + a CSS var; no
// datastar involvement — the grid column already reads the sidebar-width var.
// Deferred to DOMContentLoaded: the handle lives in the body, after this script.
document.addEventListener('DOMContentLoaded', () => {
(() => {
  const handle = document.getElementById('sidebar-resize');
  if (!handle) return;
  const MIN = 200, MAX = 480;
  const clamp = (v) => Math.min(MAX, Math.max(MIN, v));
  const setW = (w) => document.documentElement.style.setProperty('--sidebar-w', clamp(w) + 'px');
  try {
    const saved = localStorage.getItem('mf-sidebar-w');
    if (saved) { const n = parseInt(saved, 10); if (n > 0) setW(n); }
  } catch {}
  let startX = 0, startW = 280;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 280;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev) => setW(startW + (ev.clientX - startX));
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('mf-sidebar-w', getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'));
      } catch {}
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
})();
});`,
          }}
        />
      </head>
      <body class="h-dvh flex flex-col bg-white text-gray-900">
        <noscript>You need to enable JavaScript to run this app.</noscript>
        <div class="mx-2 flex-1 min-h-0 flex flex-col">{children}</div>
      </body>
    </html>
  )
}

export default Layout