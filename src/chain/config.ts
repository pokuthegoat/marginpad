import { defineChain, type Address, type Chain } from 'viem'

/**
 * Testnet chain configuration. There is deliberately no mainnet here: Robinhood Chain mainnet (4663) and every other
 * network are unsupported, and the contracts' deploy script refuses them too.
 */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
})

/**
 * Robinhood Chain MAINNET. Real funds. Supported by the code but OFF by default: a build only targets it when
 * VITE_CHAIN_ID=4663 AND VITE_ALLOW_MAINNET=true are both set (both public, read at build time). The contracts are
 * unaudited, so do not enable this for real users.
 */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

const LOCAL_ANVIL_ID = 31337

/** Local Anvil chain, for development only. It does not exist in production builds (no localhost URL is shipped). */
export const localAnvil = import.meta.env.DEV ? defineChain({
  id: 31337,
  name: 'Local Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
}) : null

/**
 * Which chain the app talks to is decided by VITE_CHAIN_ID (public, read at build time).
 *  - Development (`npm run dev`): defaults to Local Anvil (31337); set VITE_CHAIN_ID=46630 to use the testnet.
 *  - Production builds (Vercel): VITE_CHAIN_ID MUST be set to 46630 (Robinhood Chain Testnet). There is no default and
 *    no fallback, and Local Anvil is never used, so a production site can never silently point at localhost or at
 *    the wrong network. If it is missing or unsupported, the app reports a configuration error instead.
 * Mainnet (4663) needs the explicit VITE_ALLOW_MAINNET=true opt-in on top of VITE_CHAIN_ID=4663.
 *
 * VITE_RPC_URL optionally replaces the public RPC (e.g. a provider URL). In production it must be https.
 */
const requested = import.meta.env.VITE_CHAIN_ID as string | undefined
const wanted = requested ? Number(requested) : import.meta.env.DEV ? LOCAL_ANVIL_ID : undefined

function resolveChain(): { chain: Chain; error: string | null } {
  if (wanted === robinhoodTestnet.id) return { chain: withRpcOverride(robinhoodTestnet), error: null }
  if (wanted === robinhoodMainnet.id) {
    if (import.meta.env.VITE_ALLOW_MAINNET === 'true') return { chain: withRpcOverride(robinhoodMainnet), error: null }
    return {
      chain: robinhoodTestnet,
      error: 'Robinhood Chain mainnet (4663) is not enabled in this build (it needs VITE_ALLOW_MAINNET=true).',
    }
  }
  if (localAnvil && wanted === LOCAL_ANVIL_ID) return { chain: localAnvil, error: null }
  return {
    chain: robinhoodTestnet,
    error: requested
      ? `VITE_CHAIN_ID=${requested} is not supported. Use ${robinhoodTestnet.id} (Robinhood Chain Testnet).`
      : `VITE_CHAIN_ID is not set. Set it to ${robinhoodTestnet.id} (Robinhood Chain Testnet).`,
  }
}

function withRpcOverride(chain: Chain): Chain {
  const url = import.meta.env.VITE_RPC_URL as string | undefined
  if (!url) return chain
  const ok = import.meta.env.DEV ? /^https?:\/\//.test(url) : /^https:\/\//.test(url)
  return ok ? { ...chain, rpcUrls: { default: { http: [url] } } } : chain
}

const resolved = resolveChain()

/** The one chain the app talks to (always a testnet). */
export const TARGET_CHAIN = resolved.chain

/** Set when the network is misconfigured; the app then stays read-only and shows this instead of guessing a chain. */
export const NETWORK_ERROR = resolved.error

/** What `contracts/script/Deploy.s.sol` writes, plus the first block (added by `npm run contracts:sync`). */
export interface Deployment {
  chainId: number
  deployer: Address
  owner: Address
  riskManager: Address
  marginPool: Address
  marginTrading: Address
  priceOracle: Address
  /** Market address per symbol (PLNK, FERRY, LCAT, TIDE, PONSW) */
  markets: Record<string, Address>
  deployBlock: number
}

// deployments.json (Robinhood testnet) is always bundled. deployments.local.json (Anvil, git-ignored) only in dev builds,
// so a production bundle never contains local addresses.
const files = {
  ...import.meta.glob<Deployment>('./deployments.json', { eager: true, import: 'default' }),
  ...import.meta.glob<Deployment>('./deployments.mainnet.json', { eager: true, import: 'default' }),
  ...(import.meta.env.DEV ? import.meta.glob<Deployment>('./deployments.local.json', { eager: true, import: 'default' }) : {}),
}

/** A Pons launch registered as a SYNTHETIC market on the Marginpad testnet contracts (see scripts/pons-mirror.mjs). */
export interface RegisteredPonsMarket {
  token: Address
  curve: Address
  name: string
  symbol: string
  initialPrice: number
}

const ponsFiles = {
  ...import.meta.glob<{ chainId: number; markets: RegisteredPonsMarket[] }>('./pons-markets.json', { eager: true, import: 'default' }),
  ...import.meta.glob<{ chainId: number; markets: RegisteredPonsMarket[] }>('./pons-markets.mainnet.json', { eager: true, import: 'default' }),
  ...(import.meta.env.DEV
    ? import.meta.glob<{ chainId: number; markets: RegisteredPonsMarket[] }>('./pons-markets.local.json', { eager: true, import: 'default' })
    : {}),
}

export function getRegisteredPonsMarkets(chainId: number): RegisteredPonsMarket[] {
  if (NETWORK_ERROR) return []
  for (const f of Object.values(ponsFiles)) if (f.chainId === chainId && Array.isArray(f.markets)) return f.markets
  return []
}

/** The deployment for a chain, or null if the contracts have not been deployed there (or synced) yet. */
export function getDeployment(chainId: number): Deployment | null {
  if (NETWORK_ERROR) return null
  for (const d of Object.values(files)) {
    if (d.chainId === chainId && d.marginPool && d.markets) return d
  }
  return null
}

/** One line of network context for the fine print under the trade and pool forms. */
export const NETWORK_NOTE = TARGET_CHAIN.testnet
  ? `${TARGET_CHAIN.name} only. No real funds.`
  : 'Robinhood Chain mainnet: real funds. Unaudited software; you can lose everything you deposit or trade.'

export const explorerTx = (hash: string) => {
  const base = TARGET_CHAIN.blockExplorers?.default.url
  return base ? `${base}/tx/${hash}` : null
}
