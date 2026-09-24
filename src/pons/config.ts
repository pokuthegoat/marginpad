/**
 * Pons runs on Robinhood Chain MAINNET only. Marginpad reads it READ-ONLY (logs and view calls): the app never signs or
 * sends a transaction on this chain, and nothing here touches the wallet. Marginpad itself stays on the testnet.
 * Source and verification notes: docs/pons-integration-research.md
 */
export const PONS_CHAIN_ID = 4663

/** Pons V2 launch factory (official docs, official repo, and confirmed on chain). */
export { PONS_V2_FACTORY } from './eligibility'

/** Public Robinhood Chain mainnet RPC. VITE_PONS_RPC_URL (https) may replace it. */
const override = import.meta.env.VITE_PONS_RPC_URL as string | undefined
export const PONS_RPC_URL =
  override && /^https:\/\//.test(override) ? override : 'https://rpc.mainnet.chain.robinhood.com'

/** How far back to look for launches, and how many tokens to show. The RPC caps a log query at 10,000 results. */
export const PONS_SCAN_CHUNK = 100_000
export const PONS_MAX_CHUNKS = 3
export const PONS_MAX_TOKENS = 24
