import type { FC, PropsWithChildren } from 'hono/jsx'

interface LayoutProps {
  title?: string
}

const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title = 'Miniflux Reader', children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="icon" href="/favicon.svg" />
        <link rel="stylesheet" href="/style.css" />
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
            __html: `window.dsGetPath = null;
// Return the id of the story currently at the top of the list container
// (first element whose top is at/just below the container top, partial
// visibility counts). Used by m/s keys and by dsNav as the anchor.
window.dsCurrentId = () => {
  const wrapper = Array.from(document.querySelectorAll('div')).find(d => d.hasAttribute('data-on:scroll'));
  const items = Array.from(document.querySelectorAll('[data-entry-id]'));
  if (!wrapper) return null;
  const top = wrapper.getBoundingClientRect().top;
  for (const el of items) {
    if (el.getBoundingClientRect().bottom > top) return Number(el.getAttribute('data-entry-id'));
  }
  return null;
};
// dsNav is a dumb forward/back button. It finds whatever story is at the TOP
// of the list container, then advances one story forward (▼) or back (▲) in
// DOM order, and snaps that story's top flush to the container's top. No
// hover, no selection, no skip-read — it never inspects read state.
window.dsNav = (dir) => {
  const wrapper = Array.from(document.querySelectorAll('div')).find(d => d.hasAttribute('data-on:scroll'));
  const items = Array.from(document.querySelectorAll('[data-entry-id]'));
  if (!items.length || !wrapper) return null;

  // Anchor on the story currently at the top of the container.
  const wrapperRect = wrapper.getBoundingClientRect();
  let anchorIdx = items.findIndex(el => el.getBoundingClientRect().top >= wrapperRect.top - 8);
  if (anchorIdx === -1) anchorIdx = items.length; // nothing below the top edge — end of list

  let target = null;
  if (dir > 0) {
    for (let i = Math.min(anchorIdx + 1, items.length - 1); i < items.length; i++) { target = items[i]; break; }
  } else {
    for (let i = anchorIdx - 1; i >= 0; i--) { target = items[i]; break; }
  }
  if (!target) return null;

  // Snap target flush to the container's top. Single DOM touch.
  const targetId = Number(target.getAttribute('data-entry-id'));
  const targetRect = target.getBoundingClientRect();
  wrapper.scrollTop = wrapper.scrollTop + (targetRect.top - wrapperRect.top);
  return targetId;
};
window.dsEntryIds = () => Array.from(document.querySelectorAll('[data-entry-id]')).map((el) => Number(el.getAttribute('data-entry-id')));
document.addEventListener('error', (e) => {
  const target = e.target;
  if (target instanceof HTMLImageElement && target.closest('aside[data-testid="feed-panel"]')) {
    target.style.display = 'none';
    const letter = target.nextElementSibling;
    if (letter instanceof HTMLElement) letter.style.display = 'inline-flex';
  }
}, true);
// Persisted reader preferences (NOT in the URL) — boot from localStorage, save on change.
document.addEventListener('datastar-ready', () => {
  import('https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js').then((mod) => {
    window.dsGetPath = mod.getPath;
    const saved = localStorage.getItem('mf-prefs');
    if (saved) {
      try {
        mod.mergePatch(JSON.parse(saved));
      } catch {}
    }
  });
});
document.addEventListener('datastar-ready', () => {
  import('https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js').then(({ getPath }) => {
    const save = () => {
      try {
        localStorage.setItem('mf-prefs', JSON.stringify({
          hideEmptyFeeds: getPath('hideEmptyFeeds'),
          hideReadItems: getPath('hideReadItems'),
          disabledAutoReadFeeds: getPath('disabledAutoReadFeeds'),
        }));
      } catch {}
    };
    // Save on patch events for the pref signals.
    document.addEventListener('datastar-signal-patch', (e) => {
      const patch = e.detail || {};
      if ('hideEmptyFeeds' in patch || 'hideReadItems' in patch || 'disabledAutoReadFeeds' in patch) save();
    });
  });
});
document.addEventListener('datastar-ready', () => {
  import('https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js').then(({ attribute }) => {
    attribute({
      name: 'on-intersect-line',
      requirement: { key: 'denied', value: 'must' },
      apply({ el, rx }) {
        const scrollRoot = el.closest('[data-testid="entry-list"]')?.parentElement
          ?? document.body;
        let first = true;
        const observer = new IntersectionObserver((entries) => {
          // IntersectionObserver reports initial state on observe(); ignore that
          // mount report so a freshly-patched row sitting on the line doesn't
          // immediately auto-read. Fire only on real later crossings.
          if (first) { first = false; return; }
          for (const entry of entries) {
            if (entry.isIntersecting) rx();
          }
        }, {
          root: scrollRoot,
          rootMargin: '-15% 0px -85% 0px',
          threshold: 0,
        });
        observer.observe(el);
        return () => observer.disconnect();
      },
    });
  });
});
document.addEventListener('datastar-ready', () => {
  import('https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js').then(({ attribute }) => {
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