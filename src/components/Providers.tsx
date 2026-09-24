import type { ReactNode } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { PRIVY_APP_ID } from '../lib/config'
import { TARGET_CHAIN } from '../chain/config'
import { AccountProvider } from './account/AccountProvider'

/**
 * App-wide client providers.
 *
 * Privy is configured for external-wallet login only (no embedded wallets). The only chain it knows is the testnet
 * the app targets (Robinhood Chain Testnet, or local Anvil in development): never a mainnet.
 */
export default function Providers({ children }: { children: ReactNode }) {
  // Without an App ID, skip Privy entirely so the site behaves exactly as before.
  if (!PRIVY_APP_ID) return <>{children}</>

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['wallet'],
        defaultChain: TARGET_CHAIN,
        supportedChains: [TARGET_CHAIN],
        appearance: { theme: 'dark', accentColor: '#1d4ed8', showWalletLoginFirst: true },
      }}
    >
      <AccountProvider>{children}</AccountProvider>
    </PrivyProvider>
  )
}
