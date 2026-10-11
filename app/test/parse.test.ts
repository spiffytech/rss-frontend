import { describe, expect, test } from 'bun:test'

import { parseFeedBody } from '../src/server/fetch/parse'
import { epochMs } from '../src/shared/ids'

const sha = (v: string) => new Bun.CryptoHasher('sha256').update(v).digest('hex')
const NOW = 1_750_000_000_000
const opts = { now: NOW, jitterSeconds: () => 0 }

const rssFeed = (items: string) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Blog</title>
    <link>https://a.example/</link>
    ${items}
  </channel>
</rss>`

describe('parse pipeline (feedsmith + quirks + MF hashes)', () => {
  test('RSS: MF hash chain end-to-end (MF vector guid "1234")', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>One</title><guid isPermaLink="false">1234</guid></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe('03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4')
  })

  test('RSS: NB content selection stores the long html body while identity stays guid-based', () => {
    const feed = parseFeedBody(
      rssFeed(`<item>
        <title>One</title>
        <link>https://a.example/1</link>
        <guid isPermaLink="false">g1</guid>
        <description>short</description>
        <content:encoded><![CDATA[<p>long body here</p>]]></content:encoded>
      </item>`),
      'https://a.example/feed',
      opts,
    )
    const item = feed.items[0]!
    expect(item.hash).toBe(sha('g1'))
    expect(item.content).toBe('<p>long body here</p>')
    expect(item.url).toBe('https://a.example/1')
  })

  test('RSS: duplicate guids go through MF’s ladder (supersedes NB’s replacement)', () => {
    const feed = parseFeedBody(
      rssFeed(`<item>
        <guid isPermaLink="false">dup</guid>
        <title>A</title>
        <link>https://a.example/a</link>
      </item>
      <item>
        <guid isPermaLink="false">dup</guid>
        <title>B</title>
        <link>https://a.example/b</link>
      </item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items.map((i) => i.hash)).toEqual([sha('dup'), sha('dup|https://a.example/b')])
  })

  test('RSS: no guid → SHA256(raw url)', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>One</title><link>https://a.example/post</link></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe(sha('https://a.example/post'))
  })

  test('mojibake repair applies before parsing', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>Apple&acirc;&#128;&#153;s</title><guid isPermaLink="false">g</guid></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.title).toBe('Apple\u2019s')
  })

  test('malformed XML survives via control-char stripping', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>One\u0007</title><guid isPermaLink="false">g</guid></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.title).toContain('One')
  })

  test('dates clamp per NB: 1999 stamps become the fetch time', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>Old</title><guid isPermaLink="false">g</guid><pubDate>Fri, 01 Jan 1999 00:00:00 GMT</pubDate></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.publishedAt).toBe(epochMs(NOW))
  })

  test('Atom: identity is id first, link fallback', () => {
    const feed = parseFeedBody(
      `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>T</title>
        <link rel="alternate" href="https://a.example/"/>
        <entry>
          <id>urn:x:1</id>
          <title>One</title>
          <link rel="alternate" href="https://a.example/1"/>
          <updated>2024-01-01T10:00:00Z</updated>
          <content type="html">&lt;p&gt;hi&lt;/p&gt;</content>
        </entry>
      </feed>`,
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe(sha('urn:x:1'))
    expect(feed.items[0]!.url).toBe('https://a.example/1')
  })

  test('JSON Feed: trimmed identity chain', () => {
    const feed = parseFeedBody(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1',
        title: 'T',
        home_page_url: 'https://a.example/',
        items: [{ id: 'abc', url: 'https://a.example/1', content_html: '<p>hi</p>', date_published: '2024-01-01T10:00:00Z' }],
      }),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe(sha('abc'))
    expect(feed.items[0]!.content).toBe('<p>hi</p>')
  })
})
