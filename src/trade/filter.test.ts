import { describe, expect, it } from 'vitest'
import { TOKENS } from '../store/market'
import { LOW_LEVERAGE_MAX, NO_FILTERS, filterMarkets, isFiltered, type MarketQuery } from './filter'

const prices = Object.fromEntries(TOKENS.map((t) => [t.id, t.price]))
const symbols = (q: Partial<MarketQuery>, p = prices) => filterMarkets(TOKENS, p, { ...NO_FILTERS, ...q }).map((t) => t.symbol)

describe('search', () => {
  it('shows every market when the box is empty, in the original order', () => {
    expect(symbols({})).toEqual(TOKENS.map((t) => t.symbol))
  })

  it('matches on the symbol, case-insensitively', () => {
    expect(symbols({ query: 'ferry' })).toEqual(['FERRY'])
    expect(symbols({ query: 'PLNK' })).toEqual(['PLNK'])
    expect(symbols({ query: 'pOnSw' })).toEqual(['PONSW'])
  })

  it('matches on the name, including part of it', () => {
    expect(symbols({ query: 'ledger' })).toEqual(['LCAT']) // name "Ledger Cat", symbol LCAT
    expect(symbols({ query: 'cat' })).toEqual(['LCAT'])
    expect(symbols({ query: 'ponsw' })).toEqual(['PONSW'])
  })

  it('matches part of a symbol and ignores spaces around the text', () => {
    expect(symbols({ query: '  ti ' })).toEqual(['TIDE'])
    expect(symbols({ query: 'ID' })).toEqual(['TIDE'])
  })

  it('returns nothing when nothing matches', () => {
    expect(symbols({ query: 'zzz' })).toEqual([])
    expect(symbols({ query: '$$' })).toEqual([])
  })

  it('treats regex characters as plain text', () => {
    expect(() => symbols({ query: '.*(' })).not.toThrow()
    expect(symbols({ query: '.*' })).toEqual([])
  })
})

describe('leverage filters', () => {
  it('splits the markets at the lower-leverage limit with no overlap and nothing lost', () => {
    const low = symbols({ filter: 'low' })
    const high = symbols({ filter: 'high' })
    expect(low).toEqual(['PLNK', 'FERRY', 'LCAT'])
    expect(high).toEqual(['TIDE', 'PONSW'])
    expect([...low, ...high].sort()).toEqual(TOKENS.map((t) => t.symbol).sort())
    for (const t of TOKENS) expect(t.maxLeverage <= LOW_LEVERAGE_MAX).toBe(low.includes(t.symbol))
  })

  it('"all" changes nothing', () => {
    expect(symbols({ filter: 'all' })).toEqual(TOKENS.map((t) => t.symbol))
  })

  it('combines with search', () => {
    expect(symbols({ filter: 'low', query: 'l' })).toEqual(['PLNK', 'LCAT']) // Plank, Ledger Cat (Ferry has no "l")
    expect(symbols({ filter: 'high', query: 'plnk' })).toEqual([])
  })
})

describe('sorting', () => {
  it('sorts by price, either way', () => {
    expect(symbols({ sortKey: 'price', sortDir: 'desc' })).toEqual(['PONSW', 'TIDE', 'LCAT', 'FERRY', 'PLNK'])
    expect(symbols({ sortKey: 'price', sortDir: 'asc' })).toEqual(['PLNK', 'FERRY', 'LCAT', 'TIDE', 'PONSW'])
  })

  it('uses the LIVE price, so the order follows the moving mock prices', () => {
    const moved = { ...prices, plnk: 99 } // PLNK jumps above everything
    expect(symbols({ sortKey: 'price', sortDir: 'desc' }, moved)[0]).toBe('PLNK')
  })

  it('sorts by 24h change (biggest gain first when descending, biggest fall first when ascending)', () => {
    expect(symbols({ sortKey: 'change', sortDir: 'desc' })).toEqual(['PLNK', 'PONSW', 'LCAT', 'TIDE', 'FERRY'])
    expect(symbols({ sortKey: 'change', sortDir: 'asc' })).toEqual(['FERRY', 'TIDE', 'LCAT', 'PONSW', 'PLNK'])
  })

  it('sorts by market cap', () => {
    expect(symbols({ sortKey: 'cap', sortDir: 'desc' })).toEqual(['PONSW', 'TIDE', 'LCAT', 'FERRY', 'PLNK'])
    expect(symbols({ sortKey: 'cap', sortDir: 'asc' })).toEqual(['PLNK', 'FERRY', 'LCAT', 'TIDE', 'PONSW'])
  })

  it('sorts only what the search and filter left, and never mutates the source list', () => {
    const before = TOKENS.map((t) => t.symbol)
    expect(symbols({ filter: 'low', sortKey: 'cap', sortDir: 'desc' })).toEqual(['LCAT', 'FERRY', 'PLNK'])
    expect(TOKENS.map((t) => t.symbol)).toEqual(before)
  })

  it('keeps the original order for ties', () => {
    const tied = { ...prices, ferry: 1, ledgr: 1 }
    expect(symbols({ sortKey: 'price', sortDir: 'desc' }, tied).filter((s) => s === 'FERRY' || s === 'LCAT')).toEqual(['FERRY', 'LCAT'])
  })
})

describe('isFiltered', () => {
  it('is false only when nothing is narrowing or reordering the list', () => {
    expect(isFiltered(NO_FILTERS)).toBe(false)
    expect(isFiltered({ ...NO_FILTERS, query: '   ' })).toBe(false)
    expect(isFiltered({ ...NO_FILTERS, query: 'x' })).toBe(true)
    expect(isFiltered({ ...NO_FILTERS, filter: 'low' })).toBe(true)
    expect(isFiltered({ ...NO_FILTERS, sortKey: 'price' })).toBe(true)
  })
})
