export type Side = 'long' | 'short'

export interface Token {
  id: string
  name: string
  symbol: string
  /** Price in USD */
  price: number
  change24h: number
  marketCap: number
  liquidity: number
  volume24h: number
  maxLeverage: number
  /** Most pool capital this market may draw, in ETH */
  poolCap: number
  /** Pool capital already borrowed by other traders at the start, in ETH */
  seedUsed: number
  /** Per-tick price volatility used by the mock feed */
  vol: number
  /** Maintenance margin as a share of position size */
  maintenance: number
  /** Where the market comes from. Undefined means a native Marginpad demo market. */
  source?: 'demo' | 'pons'
  /** Registered as a market on the Marginpad testnet contracts (so it can be traded). Pons markets only. */
  registered?: boolean
  /** The Pons curve has graduated (or Marginpad marked the market graduated): no new positions. Pons markets only. */
  graduated?: boolean
  /** discovered (eligible on Pons) < registered (enabled in Marginpad RiskManager) < tradable (registered, fresh oracle price). */
  ponsState?: 'discovered' | 'registered' | 'tradable' | 'graduated'
  /** Market id on the Marginpad contracts. Demo markets use the address from deployments.json instead. */
  address?: string
  /** 'unavailable' when no reliable price exists (Pons-derived markets in this MVP) */
  priceStatus?: 'live' | 'unavailable'
}

export const TOKENS: Token[] = [
  {
    id: 'plnk', name: 'Plank', symbol: 'PLNK', price: 0.00042, change24h: 12.4,
    marketCap: 42_000, liquidity: 9_500, volume24h: 18_200, maxLeverage: 1.5,
    poolCap: 3, seedUsed: 0.5, vol: 0.03, maintenance: 0.08,
  },
  {
    id: 'ferry', name: 'Ferry', symbol: 'FERRY', price: 0.0087, change24h: -6.1,
    marketCap: 180_000, liquidity: 41_000, volume24h: 96_000, maxLeverage: 2,
    poolCap: 12, seedUsed: 4, vol: 0.022, maintenance: 0.07,
  },
  {
    id: 'ledgr', name: 'Ledger Cat', symbol: 'LCAT', price: 0.061, change24h: 3.8,
    marketCap: 640_000, liquidity: 128_000, volume24h: 310_000, maxLeverage: 4,
    poolCap: 45, seedUsed: 20, vol: 0.016, maintenance: 0.06,
  },
  {
    id: 'tidal', name: 'Tidal', symbol: 'TIDE', price: 0.42, change24h: -1.9,
    marketCap: 2_400_000, liquidity: 520_000, volume24h: 1_100_000, maxLeverage: 7,
    poolCap: 90, seedUsed: 45, vol: 0.011, maintenance: 0.05,
  },
  {
    id: 'ponsx', name: 'Ponsworth', symbol: 'PONSW', price: 2.85, change24h: 5.2,
    marketCap: 9_800_000, liquidity: 2_300_000, volume24h: 4_600_000, maxLeverage: 10,
    poolCap: 160, seedUsed: 90, vol: 0.007, maintenance: 0.05,
  },
]

/** Markets added at runtime (Pons launches). The static demo list above is never modified. */
let extraMarkets: Token[] = []
export const setExtraMarkets = (tokens: Token[]) => {
  extraMarkets = tokens
}

/** Mainnet deployments have no demo markets, so the demo list is switched off there (see StoreProvider). */
let demoEnabled = true
export const setDemoMarketsEnabled = (enabled: boolean) => {
  demoEnabled = enabled
}

export const allMarkets = () => [...(demoEnabled ? TOKENS : []), ...extraMarkets]

export const tokenById = (id: string) => (TOKENS.find((t) => t.id === id) ?? extraMarkets.find((t) => t.id === id))!

export interface PositionShape {
  side: Side
  size: number
  entry: number
}

export function sizeFor(collateral: number, leverage: number) {
  const size = collateral * leverage
  return { size, borrowed: size - collateral }
}

/**
 * Price at which equity falls to the maintenance margin.
 * Long: e * (1 - 1/L + m). Short: e * (1 + 1/L - m).
 */
export function liquidationPrice(entry: number, leverage: number, side: Side, maintenance: number) {
  const buffer = 1 / leverage - maintenance
  return side === 'long' ? entry * (1 - buffer) : entry * (1 + buffer)
}

/** Profit or loss in ETH at the given token price. */
export function pnlFor(p: PositionShape, price: number) {
  const dir = p.side === 'long' ? 1 : -1
  return p.size * (price / p.entry - 1) * dir
}

export function isLiquidated(p: PositionShape & { liq: number }, price: number) {
  return p.side === 'long' ? price <= p.liq : price >= p.liq
}

/**
 * Sync one market's risk settings from the chain. The contract is the source of truth for max leverage,
 * maintenance margin and the pool cap; the constants above are only the starting values and the display metadata.
 */
export function applyOnchainRisk(id: string, r: { maxLeverage: number; maintenance: number; poolCap: number }) {
  const t = allMarkets().find((x) => x.id === id)
  if (!t) return
  t.maxLeverage = r.maxLeverage
  t.maintenance = r.maintenance
  t.poolCap = r.poolCap
}
