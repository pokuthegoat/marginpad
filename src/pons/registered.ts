import { getRegisteredPonsMarkets } from '../chain/config'
import { tokenFromRegistry } from './markets'
import type { Token } from '../store/market'

/**
 * Markets listed in the registry file for this chain (written by `npm run pons:register` locally, `pons:prepare` for mainnet).
 * They are only a starting point: whether a market is really registered and tradable is read from the Marginpad chain.
 */
export function registryTokens(chainId: number): Token[] {
  return getRegisteredPonsMarkets(chainId).map(tokenFromRegistry)
}
