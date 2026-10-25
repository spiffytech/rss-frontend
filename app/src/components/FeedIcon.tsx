import { Show } from 'solid-js'

import type { FeedId } from '../shared/ids'
import { useReader } from '../lib/reader-context'

/**
 * The feed's icon, with a letter fallback when the <img> errors.
 *
 * `/api/icons/:id` stays a plain URL endpoint rather than a server function: it
 * is an <img src>, and an <img> cannot speak the RPC protocol.
 */
export const FeedIcon = (props: { feedId: FeedId; title: string }) => {
  const r = useReader()
  const { markIconFailed } = r
  const failed = () => r.session.iconFailed[props.feedId] === true

  return (
    <span class="inline-flex items-center self-center shrink-0 relative w-5 h-5" aria-hidden="true">
      <img
        src={`/api/icons/${props.feedId}`}
        alt=""
        class={['w-5 h-5 rounded-sm', { hidden: failed() }]}
        loading="lazy"
        onError={() => markIconFailed(props.feedId)}
      />
      <Show when={failed()}>
        <span class="absolute inset-0 inline-flex items-center justify-center rounded-sm bg-gray-200 text-gray-600 text-xs font-semibold">
          {(props.title.trim()[0] ?? '?').toUpperCase()}
        </span>
      </Show>
    </span>
  )
}

export default FeedIcon
