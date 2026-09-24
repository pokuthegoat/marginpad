import type { RegisteredPonsMarket } from '../chain/config'
import type { Token } from '../store/market'
import type { PonsMarketInfo } from './discover'
import { ponsPriceEth } from './discover'

/**
 * Turning Pons launches into entries of Marginpad's market list, and keeping three ideas apart:
 *
 *   DISCOVERED  the launch exists on Pons and passes the eligibility rules (read from Pons, mainnet).
 *   REGISTERED  Marginpad's RiskManager has actually enabled a market for that token address (read from the Marginpad chain).
 *   TRADABLE    registered, not graduated, and the Marginpad oracle price is fresh, so positions can really be opened.
 *
 * Discovery never registers anything. The price shown for a discovered-only market is the curve price for display; once a market
 * is registered the price shown (and used for trading) is the Marginpad oracle price.
 */

export type PonsState = NonNullable<Token['ponsState']>

/** Conservative defaults shown until the chain reports the real risk settings (they match the registration defaults). */
const DEFAULT_RISK = { maxLeverage: 1.5, poolCap: 1, maintenance: 0.1 }

export const ponsTokenId = (address: string) => `pons-${address.toLowerCase()}`

const blank = (address: string, name: string, symbol: string, price: number): Token => ({
  id: ponsTokenId(address),
  name,
  symbol,
  price,
  change24h: 0,
  marketCap: 0,
  liquidity: 0,
  volume24h: 0,
  maxLeverage: DEFAULT_RISK.maxLeverage,
  poolCap: DEFAULT_RISK.poolCap,
  seedUsed: 0,
  vol: 0,
  maintenance: DEFAULT_RISK.maintenance,
  source: 'pons',
  priceStatus: 'unavailable',
  registered: false,
  graduated: false,
  ponsState: 'discovered',
  address,
})

export function tokenFromDiscovery(m: PonsMarketInfo): Token {
  const price = ponsPriceEth(m)
  return { ...blank(m.token, m.name, m.symbol, price ?? 0), price: price ?? 0, priceStatus: price === null ? 'unavailable' : 'live', graduated: m.graduated }
}

/** A market listed in the registry file (`npm run pons:register` / `pons:prepare`): assumed registered until the chain says otherwise. */
export function tokenFromRegistry(m: RegisteredPonsMarket): Token {
  return { ...blank(m.token, m.name, m.symbol, m.initialPrice), priceStatus: 'live', registered: true, ponsState: 'registered' }
}

/** Discovered launches plus registry entries, one token per address. Discovery supplies the freshest name, price and graduation. */
export function mergePonsTokens(discovered: PonsMarketInfo[], registry: Token[]): Token[] {
  const out = new Map<string, Token>()
  for (const r of registry) out.set(r.address!.toLowerCase(), r)
  for (const m of discovered) {
    const key = m.token.toLowerCase()
    const fresh = tokenFromDiscovery(m)
    const known = out.get(key)
    out.set(key, known ? { ...known, name: fresh.name, symbol: fresh.symbol, price: fresh.price || known.price, priceStatus: fresh.priceStatus, graduated: fresh.graduated } : fresh)
  }
  return [...out.values()]
}

/** What the Marginpad chain says about the markets (a slice of the chain snapshot). */
export interface ChainStatusSlice {
  risk: Record<string, { enabled: boolean }>
  stale: Record<string, boolean>
  graduated: Record<string, boolean>
}

/**
 * Sets `registered`, `graduated` and `ponsState` on Pons tokens from the Marginpad chain. Mutates in place, like
 * `applyOnchainRisk`, because tokens are shared module-level objects.
 */
export function applyPonsStatus(tokens: Token[], chain: ChainStatusSlice | null): void {
  for (const t of tokens) {
    if (t.source !== 'pons') continue
    if (chain) {
      if (chain.risk[t.id]) t.registered = chain.risk[t.id].enabled
      if (chain.graduated[t.id]) t.graduated = true
    }
    if (t.graduated) t.ponsState = 'graduated'
    else if (!t.registered) t.ponsState = 'discovered'
    else t.ponsState = chain && chain.stale[t.id] === false ? 'tradable' : 'registered'
  }
}

const RANK: Record<PonsState, number> = { tradable: 0, registered: 1, discovered: 2, graduated: 3 }

/**
 * The market list shown on /trade.
 *  - Local and testnet: Pons markets first (tradable, registered, discovered, graduated), then the native demo markets.
 *  - Mainnet: never demo markets, and only markets Marginpad has actually registered.
 */
export function orderMarkets(demo: Token[], pons: Token[], isTestnet: boolean): Token[] {
  const list = isTestnet ? pons : pons.filter((t) => t.registered)
  const sorted = [...list].sort((a, b) => RANK[a.ponsState ?? 'discovered'] - RANK[b.ponsState ?? 'discovered'])
  return isTestnet ? [...sorted, ...demo] : sorted
}

/** The market /trade selects until the user picks one: the first tradable Pons market, else the first market. */
export function defaultMarketId(markets: Token[], preferred: string): string | undefined {
  return markets.find((m) => m.ponsState === 'tradable')?.id ?? markets.find((m) => m.id === preferred)?.id ?? markets[0]?.id
}
