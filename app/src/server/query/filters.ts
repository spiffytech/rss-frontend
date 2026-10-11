/**
 * Read-time filters: hidden keyword/tag/author lists live in each feed's
 * prefs JSON (`feed:<id>` scope) and become one SQL predicate. Lists and
 * counters share it, so what's hidden from a view is hidden from its counts —
 * retroactive by construction, no stamps.
 *
 * Matching is literal and case-insensitive (v1: no regex engine). `%`/`_`/`\`
 * in keywords are escaped so they can't act as LIKE wildcards.
 */
import { sql, type SQL } from 'drizzle-orm'

import { entries } from '../db/schema'

/** Escape LIKE wildcards in a user-supplied literal. (Backslashes are doubled
 * first so the LIKE escape char itself stays literal.) */
function likeLiteral(value: SQL): SQL {
  return sql`replace(replace(replace(lower(${value}), '\\', '\\\\'), '%', '\\%'), '_', '\\_')`
}

/**
 * True when the entry is NOT hidden by its feed's prefs. Feed prefs are read
 * per-row from `user_prefs`, so one predicate works for single-feed and
 * multi-feed views alike.
 */
export function notHiddenPredicate(): SQL {
  const feedPrefs = sql`(SELECT p.prefs FROM user_prefs p WHERE p.user_id = ${entries.userId} AND p.scope = 'feed:' || ${entries.feedId})`
  return sql`NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(json_extract(${feedPrefs}, '$.hiddenKeywords'), '[]'))
      WHERE ${likeLiteral(sql`json_each.value`)} <> ''
        AND lower(${entries.title} || ' ' || ${entries.content}) LIKE '%' || ${likeLiteral(sql`json_each.value`)} || '%' ESCAPE '\\'
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(json_extract(${feedPrefs}, '$.hiddenAuthors'), '[]'))
      WHERE ${likeLiteral(sql`json_each.value`)} <> ''
        AND lower(COALESCE(${entries.author}, '')) LIKE '%' || ${likeLiteral(sql`json_each.value`)} || '%' ESCAPE '\\'
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(json_extract(${feedPrefs}, '$.hiddenTags'), '[]'))
      WHERE EXISTS (
        SELECT 1 FROM json_each(${entries.tags}) et
        WHERE lower(et.value) = lower(json_each.value)
      )
    )`
}
