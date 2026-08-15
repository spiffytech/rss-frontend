import type { FC, PropsWithChildren } from 'hono/jsx'

interface AppContainerProps {
  signals?: Record<string, unknown>
  className?: string
  onKeydown?: string
  /** Sync filter/view signal changes into the URL query string (watches patch events). */
  watchFilter?: string
}

export const AppContainer: FC<PropsWithChildren<AppContainerProps>> = ({
  signals,
  className = 'grid gap-x-3 app-container',
  onKeydown,
  watchFilter,
  children,
}) => (
  <div
    class={className}
    data-signals={signals ? JSON.stringify(signals) : undefined}
    {...(onKeydown ? { 'data-on:keydown__window': onKeydown } : {})}
    {...(watchFilter
      ? {
          'data-on-signal-patch': watchFilter,
          'data-on-signal-patch-filter': `{include: /^filter./}`,
        }
      : {})}
  >
    {children}
  </div>
)