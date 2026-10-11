/** Typed fetch wrappers for the reader API. */
import type { EntriesFilter } from '../shared/filter'
import type { BootstrapResult, EntriesResult, EntryContent, EntryResult, FeedPanelResult, SessionInfo, ViewCursor } from '../shared/types'
import type { FeedPrefs, UserPrefs } from '../shared/prefs'
import type { EntryId, FeedId } from '../shared/ids'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export const api = {
  session: () => call<SessionInfo>('/api/session'),
  login: (username: string, password: string) =>
    call<{ authenticated: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => call<{ authenticated: boolean }>('/api/logout', { method: 'POST' }),

  bootstrap: (filter: EntriesFilter) =>
    call<BootstrapResult>('/api/bootstrap', { method: 'POST', body: JSON.stringify({ filter }) }),
  entries: (filter: EntriesFilter, cursor?: ViewCursor | null) =>
    call<EntriesResult>('/api/entries', { method: 'POST', body: JSON.stringify({ filter, cursor }) }),
  content: (entryId: EntryId) => call<EntryContent>(`/api/entries/${entryId}/content`),
  panel: () => call<FeedPanelResult>('/api/panel'),

  setStatus: (entryIds: EntryId[], status: 'read' | 'unread') =>
    call<{ changed: number }>('/api/entries/status', { method: 'POST', body: JSON.stringify({ entryIds, status }) }),
  setStarred: (entryIds: EntryId[], starred: boolean) =>
    call<{ changed: number }>('/api/entries/star', { method: 'POST', body: JSON.stringify({ entryIds, starred }) }),

  setFeedPrefs: (feedId: FeedId, patch: Partial<FeedPrefs>) =>
    call<{ ok: boolean }>('/api/prefs', { method: 'PUT', body: JSON.stringify({ feedId, patch }) }),
  setUserPrefs: (patch: Partial<UserPrefs>) =>
    call<{ ok: boolean }>('/api/prefs', { method: 'PUT', body: JSON.stringify({ patch }) }),

  renameFeed: (feedId: FeedId, title: string) =>
    call<{ ok: boolean }>(`/api/feeds/${feedId}/rename`, { method: 'PUT', body: JSON.stringify({ title }) }),
  renameCategory: (categoryId: string, title: string) =>
    call<{ ok: boolean }>(`/api/categories/${categoryId}/rename`, { method: 'PUT', body: JSON.stringify({ title }) }),
  unsubscribe: (feedId: FeedId) => call<{ ok: boolean }>(`/api/feeds/${feedId}/unsubscribe`, { method: 'POST' }),
}

export type { EntryResult }
