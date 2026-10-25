import { For, Show } from "solid-js";

import { useReader } from '../lib/reader-context'
import { FeedIcon } from "./FeedIcon";

/**
 * The home page: links to your favorite feeds that have something unread, and
 * nothing else. It is a navigation aid, not a reading surface — no entries, no
 * counts, no ordering beyond alphabetical.
 *
 * A favorite with nothing unread is left out (it is not going to be read), but
 * the page says so rather than claiming you have no favorites at all. Favoriting
 * happens from the feed menu (`⋮`); a favorited feed keeps living in its
 * category, unchanged.
 */
export const Home = () => {
  const r = useReader()
  const { favoriteFeeds, favoriteFeedsWithUnread } = r
  const unread = () => favoriteFeedsWithUnread();
  const anyFavorites = () => favoriteFeeds().length > 0;

  return (
    // A capped width keeps each title and its count one glance apart. Stretched
    // across a wide window the count drifts to the far edge and reads as absent.
    <section class="px-2 py-4 max-w-xl" data-testid="home">
      <h1 class="font-semibold text-lg mb-3">Favorites</h1>
      <Show
        when={unread().length > 0}
        fallback={
          <Show
            when={anyFavorites()}
            fallback={
              <p class="text-sm text-gray-500" data-testid="home-no-favorites">
                No favorite feeds yet. Open a feed, then use &#8942; &rarr; Favorite feed.
              </p>
            }
          >
            <p class="text-sm text-gray-500" data-testid="home-caught-up">
              Nothing unread in your favorite feeds.
            </p>
          </Show>
        }
      >
        <ul class="flex flex-col gap-y-1" data-testid="home-favorites">
          <For each={unread()}>
            {(feed) => (
              <li>
                <a
                  href={`/?feed=${feed.id}`}
                  data-testid="home-favorite-link"
                  class="flex items-center gap-x-2 px-2 py-1.5 rounded hover:bg-gray-100 text-sm"
                >
                  <FeedIcon feedId={feed.id} title={feed.title} />
                  {/* Icon is centred against the text; the count shares the
                      name's baseline rather than being centred on it (a 12px
                      number centred on a 14px line sits visibly high). */}
                  <span class="min-w-0 flex items-baseline gap-x-2">
                    <span class="truncate">{feed.title}</span>
                    <span
                      data-testid="home-favorite-count"
                      class="shrink-0 text-xs text-gray-500 tabular-nums"
                    >
                      {r.counterFor(feed.id)}
                    </span>
                  </span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
};

export default Home;
