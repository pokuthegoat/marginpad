import type { Token } from '../store/market'

/**
 * Search, filter and sort for the Trade page's market list. Pure functions over the mock market data, so the list
 * updates instantly as the controls change and the rules can be tested without a browser.
 */

/** Markets allowing up to this leverage count as "lower leverage"; anything above it is "higher leverage". */
export const LOW_LEVERAGE_MAX = 4

export type LeverageFilter = 'all' | 'low' | 'high'
export type SortKey = 'default' | 'price' | 'change' | 'cap'
export type SortDir = 'desc' | 'asc'

export interface MarketQuery {
  query: string
  filter: LeverageFilter
  sortKey: SortKey
  sortDir: SortDir
}

export const NO_FILTERS: MarketQuery = { query: '', filter: 'all', sortKey: 'default', sortDir: 'desc' }

/** True when anything narrows or reorders the list, so a "clear" control has something to undo. */
export const isFiltered = (q: MarketQuery) => q.query.trim() !== '' || q.filter !== 'all' || q.sortKey !== 'default'

export const SORT_LABEL: Record<SortKey, string> = {
  default: 'Default order',
  price: 'Price',
  change: '24h change',
  cap: 'Market cap',
}

/** Case-insensitive match on the token's name or symbol, on any part of either (whitespace at the ends is ignored). */
function matchesQuery(t: Token, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q)
}

function matchesFilter(t: Token, filter: LeverageFilter) {
  if (filter === 'low') return t.maxLeverage <= LOW_LEVERAGE_MAX
  if (filter === 'high') return t.maxLeverage > LOW_LEVERAGE_MAX
  return true
}

/**
 * The markets to show, in order. `prices` are the live mock prices (they move every second or so), the rest of the
 * numbers come from the token itself. Sorting is stable, so ties keep the original order.
 */
export function filterMarkets(tokens: Token[], prices: Record<string, number>, q: MarketQuery): Token[] {
  const shown = tokens.filter((t) => matchesQuery(t, q.query) && matchesFilter(t, q.filter))
  if (q.sortKey === 'default') return shown

  const value = (t: Token) => (q.sortKey === 'price' ? (prices[t.id] ?? t.price) : q.sortKey === 'change' ? t.change24h : t.marketCap)
  const dir = q.sortDir === 'desc' ? -1 : 1
  return shown
    .map((t, i) => ({ t, i, v: value(t) }))
    .sort((a, b) => dir * (a.v - b.v) || a.i - b.i)
    .map((x) => x.t)
}
